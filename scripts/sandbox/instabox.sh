#!/bin/bash
# The InstaBox adapter: runs a preview of a branch on an InstaBox box and gives it a link the owner
# can open on a phone. Runs where the instabox CLI is signed in (instabox login, or INSTABOX_API_KEY
# in CI). The box gets no Secrets: previews use verify mode's fake Coach and fake data.
#   bash scripts/sandbox/instabox.sh up [--ref BRANCH] [--seed NAME] [--box NAME] [--notify]
#   bash scripts/sandbox/instabox.sh down [--box NAME] [--delete]
#   bash scripts/sandbox/instabox.sh status [--box NAME]
# up prints the link, with the pairing code in it, and ends with one JSON line. The link goes only to
# the owner (--notify sends it through telegram-notify), never into a PR or anywhere public (ADR 0001).
# The free plan has one box in all: reuse it (the default name), or delete the old one first.

box=${INSTABOX_PREVIEW_BOX:-occ-preview}
repo=${OCC_REPO_URL:-https://github.com/inprealpha/OpenChessCoach.git}
port=8790
seed=default
ref=
notify=0
delete=0

usage() {
  sed -n '5,7p' "${BASH_SOURCE[0]}" | sed 's/^#  */usage: /' >&2
  exit 2
}
command=${1:-}
[ -n "$command" ] || usage
shift
while [ $# -gt 0 ]; do
  case "$1" in
    --box) [ -n "${2:-}" ] || usage; box=$2; shift 2 ;;
    --ref) [ -n "${2:-}" ] || usage; ref=$2; shift 2 ;;
    --seed) [ -n "${2:-}" ] || usage; seed=$2; shift 2 ;;
    --notify) notify=1; shift ;;
    --delete) delete=1; shift ;;
    *) usage ;;
  esac
done
# Names and refs go into a shell command on the box: only the characters git and instabox allow.
[[ "$box" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || { echo "instabox: box names are lowercase letters, digits and -" >&2; exit 2; }
[[ "$seed" =~ ^[a-z-]+$ ]] || usage
check_ref() { [[ "$1" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "instabox: that branch name has characters this script doesn't pass on" >&2; exit 2; }; }
[ -z "$ref" ] || check_ref "$ref"

command -v instabox >/dev/null || { echo "instabox: the instabox CLI is not installed: npx instabox@latest" >&2; exit 1; }

state() { instabox get "$box" --json 2>/dev/null | node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { try { console.log(JSON.parse(s).state ?? "") } catch { console.log("") } })'; }

case "$command" in
  up)
    if [ -z "$ref" ]; then
      ref=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
      [ -n "$ref" ] && [ "$ref" != HEAD ] || { echo "instabox: no branch checked out here; pass --ref BRANCH" >&2; exit 2; }
      echo "instabox: previewing $ref as it is on GitHub (push it first if you have new commits)" >&2
    fi
    check_ref "$ref"

    current=$(state)
    case "$current" in
      '')
        echo "instabox: creating box $box" >&2
        if ! instabox create --name "$box" --secrets none --no-vault >&2; then
          echo "instabox: could not create $box. On the free plan only one box exists at a time: see instabox ls, then pass --box with that name or delete it." >&2
          exit 1
        fi ;;
      running) ;;
      stopped) instabox start "$box" >&2 || exit 1 ;;
      *) instabox resume "$box" >&2 || instabox wake "$box" >&2 || exit 1 ;;
    esac
    # Previews never hold the owner's credentials, even on a box that had a Secret selected before.
    instabox secrets select "$box" --secrets none >/dev/null || { echo "instabox: could not clear the box's Secrets" >&2; exit 1; }

    instabox exec "$box" --timeout 300 -- "set -e
      [ -d ~/OpenChessCoach/.git ] || git clone -q '$repo' ~/OpenChessCoach
      cd ~/OpenChessCoach
      git fetch -q --depth 1 origin '$ref'
      git checkout -q --force FETCH_HEAD
      echo \"instabox: $box has $ref at \$(git rev-parse --short HEAD)\" >&2" || { echo "instabox: could not check out $ref on $box" >&2; exit 1; }

    preview=$(instabox exec "$box" --timeout 600 -- "cd ~/OpenChessCoach && bash scripts/sandbox/preview.sh --seed $seed --port $port" | tail -n 1)
    node -e 'process.exit(JSON.parse(process.argv[1]).ok ? 0 : 1)' "$preview" 2>/dev/null || { echo "instabox: the preview did not start: $preview" >&2; exit 1; }

    url=$(instabox port ls "$box" --json 2>/dev/null | node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const ports = JSON.parse(s).ports ?? [];
        const p = ports.find((x) => Number(x.port) === Number(process.argv[1]));
        console.log(p?.url ?? "");
      })' "$port")
    [ -n "$url" ] || url=$(instabox port publish "$box" "$port" --json | node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => console.log(JSON.parse(s).url ?? ""))')
    [ -n "$url" ] || { echo "instabox: could not publish port $port on $box" >&2; exit 1; }

    commit=$(node -e 'console.log(JSON.parse(process.argv[1]).commit)' "$preview")
    link=$(node -e 'console.log(process.argv[2].replace(/\/$/, "") + JSON.parse(process.argv[1]).pairPath)' "$preview" "$url")
    echo "instabox: preview of $ref at $commit on $box (seed $seed), doctor passed" >&2
    echo "instabox: open $link" >&2
    if [ "$notify" = 1 ]; then
      telegram-notify "OpenChessCoach preview of $ref ($commit, seed $seed): $link" >/dev/null 2>&1 \
        || echo "instabox: telegram-notify failed; the link is above" >&2
    fi
    node -e 'const [p, box, ref, url, link] = process.argv.slice(1); const r = JSON.parse(p);
      console.log(JSON.stringify({ ok: true, box, ref, commit: r.commit, runId: r.runId, url, link }))' "$preview" "$box" "$ref" "$url" "$link" ;;

  down)
    [ -n "$(state)" ] || { echo "instabox: no box named $box"; exit 0; }
    instabox port unpublish "$box" "$port" >/dev/null 2>&1 || true
    if [ "$delete" = 1 ]; then
      instabox rm --yes "$box" >&2
    else
      instabox suspend "$box" >&2
    fi ;;

  status)
    current=$(state)
    [ -n "$current" ] || { echo "instabox: no box named $box"; exit 0; }
    echo "instabox: $box is $current"
    instabox port ls "$box" --output table 2>/dev/null ;;

  *) usage ;;
esac
