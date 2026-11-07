#!/bin/bash
# Ends the preview on a sandbox and frees disk space, so a long run of previews can't fill its disk
# (an InstaBox box has 20 GB). preview.sh --sandbox runs it first, and instabox.sh down runs it on the
# box. It deletes every verify-mode run's evidence, so it runs only with --sandbox.
#   bash scripts/sandbox/clean.sh --sandbox [--repo DIR] [--deep] [--max-percent N] [--quiet]
# Always: ends the preview's bubble (preview.sh), and with it every process the branch started there,
# then deletes the runs' files, logs, data and evidence. It never runs the branch's code to do so.
# Then, with --deep or when the disk holding the checkout is still more than N% full (default 80):
# npm's download caches, a git gc (which keeps the reflog, so stashes stay) and node_modules, which
# the next preview installs again.
# Exits 1 when the disk is still more than N% full at the end, 0 otherwise.

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=
sandbox=0
deep=0
quiet=0
max=80
usage() { echo "usage: bash scripts/sandbox/clean.sh --sandbox [--repo DIR] [--deep] [--max-percent N] [--quiet]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --sandbox) sandbox=1; shift ;;
    --repo) [ -n "${2:-}" ] || usage; repo=$2; shift 2 ;;
    --deep) deep=1; shift ;;
    --quiet) quiet=1; shift ;;
    --max-percent) [[ "${2:-}" =~ ^[0-9]+$ ]] && [ "$2" -ge 1 ] && [ "$2" -le 100 ] || usage; max=$2; shift 2 ;;
    *) usage ;;
  esac
done
if [ "$sandbox" = 0 ]; then
  echo "clean: it deletes every verify-mode run's evidence, so it runs only on a sandbox, with --sandbox" >&2
  usage
fi
say() { [ "$quiet" = 1 ] || echo "clean: $*" >&2; }

cd "${repo:-$here/../..}" 2>/dev/null && [ -f package.json ] || { echo "clean: no checkout at ${repo:-$here/../..}" >&2; exit 1; }
used() { df -P . | awk 'NR == 2 { sub("%", "", $5); print $5 }'; }
say "disk $(used)% full before"

# The preview's bubble: only the process preview.sh recorded, and only when its command line is the
# bubble's (sudo unshare … bwrap … occ-preview-bubble). Its top runs as root, so ending it takes sudo;
# ending it ends every process inside, since the bubble has its own process list.
sb=$HOME/.occ-preview-sandbox
pid=$(cat "$sb/bubble.pid" 2>/dev/null)
if [[ "$pid" =~ ^[0-9]+$ ]] && tr '\0\n' '  ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'bwrap .*occ-preview-bubble'; then
  # The recorded process is sudo; the bubble's top is the unshare under it. Ending unshare ends the
  # bubble (--kill-child ends the first process inside, and with it its process list), and then sudo
  # exits.
  for top in $(pgrep -P "$pid" -x unshare) "$pid"; do sudo -n kill "$top" 2>/dev/null; done
  for _ in $(seq 1 20); do [ -d "/proc/$pid" ] || break; sleep 0.5; done
  [ ! -d "/proc/$pid" ] || { for top in $(pgrep -P "$pid" -x unshare) "$pid"; do sudo -n kill -9 "$top" 2>/dev/null; done; }
fi
rm -f "$sb/bubble.pid"
# Verify-mode runs of this checkout started outside a bubble (by hand, or before previews used one):
# only a process whose command line names its run file, as coachctl cleanup checks.
for run in .verify/runs/*.json; do
  [ -f "$run" ] || continue
  rpid=$(node -e 'try { console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).pid ?? "") } catch {}' "$run" 2>/dev/null)
  [[ "$rpid" =~ ^[0-9]+$ ]] && [ "$rpid" != 0 ] || continue
  tr '\0\n' '  ' < "/proc/$rpid/cmdline" 2>/dev/null | grep -qF "$(pwd)/$run" && kill "$rpid" 2>/dev/null
done
rm -rf .verify/runs evidence/run-* "$sb/home/.occ-out" "$sb/tmp"
mkdir -p "$sb/tmp"

if [ "$deep" = 1 ] || [ "$(used)" -gt "$max" ]; then
  say "deep clean (npm caches, git gc, node_modules)"
  rm -rf "$sb/home/.npm/_cacache"
  npm cache clean --force >/dev/null 2>&1
  git gc -q 2>/dev/null
  rm -rf node_modules packages/*/node_modules
fi

now=$(used)
say "disk $now% full after"
if [ "$now" -gt "$max" ]; then
  echo "clean: the disk is still more than $max% full; see du -sh ~/* on the machine" >&2
  exit 1
fi
exit 0
