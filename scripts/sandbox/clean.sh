#!/bin/bash
# Frees disk space on a sandbox that runs previews, so a long run of them can't fill its disk
# (an InstaBox box has 20 GB). preview.sh runs it first, and instabox.sh down runs it on the box.
# Meant for sandboxes: it deletes the evidence of every verify-mode run in this checkout.
#   bash scripts/sandbox/clean.sh [--deep] [--max-percent N]
# Always: stops every verify-mode run (coachctl cleanup, which also deletes their data folders), then
# deletes their run files, logs and evidence folders. Then, with --deep or when the disk holding the
# checkout is still more than N% full (default 80): npm's download cache, git objects no branch
# needs, and node_modules, which prepare.sh installs again. Playwright deletes browser builds no
# checkout uses by itself, when it installs a new one.
# Exits 1 when the disk is still more than N% full at the end, 0 otherwise.

deep=0
max=80
usage() { echo "usage: bash scripts/sandbox/clean.sh [--deep] [--max-percent N]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --deep) deep=1; shift ;;
    --max-percent) [[ "${2:-}" =~ ^[0-9]+$ ]] && [ "$2" -ge 1 ] && [ "$2" -le 100 ] || usage; max=$2; shift 2 ;;
    *) usage ;;
  esac
done

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || { echo "clean: could not find the repository" >&2; exit 1; }
used() { df -P . | awk 'NR == 2 { sub("%", "", $5); print $5 }'; }
echo "clean: disk $(used)% full before" >&2

if [ -d node_modules ]; then
  npm run -s coachctl -- cleanup >/dev/null 2>&1 || echo "clean: coachctl cleanup failed; deleting the run files anyway" >&2
fi
rm -rf .verify/runs evidence/run-*

if [ "$deep" = 1 ] || [ "$(used)" -gt "$max" ]; then
  echo "clean: deep clean (npm cache, git objects, node_modules)" >&2
  npm cache clean --force >/dev/null 2>&1
  git reflog expire --expire=now --all 2>/dev/null
  git gc -q --prune=now 2>/dev/null
  rm -rf node_modules packages/*/node_modules
fi

now=$(used)
echo "clean: disk $now% full after" >&2
if [ "$now" -gt "$max" ]; then
  echo "clean: the disk is still more than $max% full; see du -sh ~/* on the machine" >&2
  exit 1
fi
exit 0
