#!/bin/bash
# The InstaBox adapter: runs a preview of a branch on an InstaBox box and gives it a link the owner
# can open on a phone. Runs where the instabox CLI is signed in (instabox login, or INSTABOX_API_KEY
# in CI). The box gets no Secrets: previews use verify mode's fake Coach and fake data.
#   bash scripts/sandbox/instabox.sh up [--ref BRANCH] [--seed NAME] [--box NAME] [--notify]
#   bash scripts/sandbox/instabox.sh down [--box NAME] [--if-ref BRANCH] [--pause | --delete]
#   bash scripts/sandbox/instabox.sh status [--box NAME]
# up prints the link, with the pairing code in it, and ends with one JSON line. The link goes only to
# the owner (--notify sends it with telegram-notify, or with TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
# in CI), never into a PR or anywhere public (ADR 0001). In GitHub Actions, whose logs are public,
# the link is never printed and the JSON line has no link.
# down stops the preview, cleans the box (clean.sh) and unpublishes the port; with --if-ref, only when
# the box is showing that branch. It leaves the box running for whatever else uses it (InstaBox pauses
# it after 30 idle minutes); --pause pauses it, --delete deletes it.
# The box is shared: the free plan has one box in all, and the owner uses it for other work too. So
# up clears the box's Secrets (PR code must never reach the owner's credentials) and says which.

box=${INSTABOX_PREVIEW_BOX:-my-instabox}
repo=${OCC_REPO_URL:-https://github.com/inprealpha/OpenChessCoach.git}
port=8790
seed=default
ref=
notify=0
delete=0
pause=0
if_ref=
# GitHub Actions logs are public: the pairing code must never reach them.
ci=0
[ "${GITHUB_ACTIONS:-}" = true ] && ci=1

usage() {
  sed -n '5,7p' "${BASH_SOURCE[0]}" | sed 's/^#  */usage: /' >&2
  exit 2
}
command=${1:-}
case "$command" in up | down | status) ;; *) usage ;; esac
shift
while [ $# -gt 0 ]; do
  case "$1" in
    --box) [ -n "${2:-}" ] || usage; box=$2; shift 2 ;;
    --ref) [ -n "${2:-}" ] || usage; ref=$2; shift 2 ;;
    --seed) [ -n "${2:-}" ] || usage; seed=$2; shift 2 ;;
    --notify) notify=1; shift ;;
    --delete) delete=1; shift ;;
    --pause) pause=1; shift ;;
    --if-ref) [ -n "${2:-}" ] || usage; if_ref=$2; shift 2 ;;
    *) usage ;;
  esac
done
# Names and refs go into a shell command on the box: only the characters git and instabox allow.
[[ "$box" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || { echo "instabox: box names are lowercase letters, digits and -" >&2; exit 2; }
[[ "$seed" =~ ^[a-z-]+$ ]] || usage
check_ref() { [[ "$1" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "instabox: that branch name has characters this script doesn't pass on" >&2; exit 2; }; }
[ -z "$ref" ] || check_ref "$ref"
[ -z "$if_ref" ] || check_ref "$if_ref"

command -v instabox >/dev/null || { echo "instabox: the instabox CLI is not installed: npx instabox@latest" >&2; exit 1; }

# Sends one message to the owner: telegram-notify on the desktop, the Bot API in CI.
notify_owner() {
  if command -v telegram-notify >/dev/null; then
    telegram-notify "$1" >/dev/null 2>&1
  elif [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    curl -fsS -o /dev/null "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" --data-urlencode "text=$1" 2>/dev/null
  else
    return 1
  fi
}

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
    selected=$(instabox secrets show "$box" 2>/dev/null | sed -n 's/^Selection: //p')
    instabox secrets select "$box" --secrets none >/dev/null || { echo "instabox: could not clear the box's Secrets" >&2; exit 1; }
    if [ -n "$selected" ] && [ "$selected" != "[]" ]; then
      echo "instabox: removed the Secrets $selected from $box, since a preview runs PR code; select them again after the preview if you need them" >&2
    fi

    instabox exec "$box" --timeout 300 -- "set -e
      [ -d ~/OpenChessCoach/.git ] || git clone -q '$repo' ~/OpenChessCoach
      cd ~/OpenChessCoach
      git fetch -q --depth 1 origin '$ref'
      git checkout -q --force FETCH_HEAD
      echo '$ref' > ~/.occ-preview-ref
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
    if [ "$ci" = 0 ]; then
      echo "instabox: open $link" >&2
    fi
    if [ "$notify" = 1 ]; then
      if notify_owner "OpenChessCoach preview of $ref ($commit, seed $seed): $link"; then
        echo "instabox: sent the link by Telegram" >&2
      elif [ "$ci" = 1 ]; then
        echo "instabox: could not send the link by Telegram, and CI logs are public, so it isn't printed here either" >&2
        exit 1
      else
        echo "instabox: could not send the link by Telegram; it is above" >&2
      fi
    fi
    [ "$ci" = 1 ] && link=
    node -e 'const [p, box, ref, url, link] = process.argv.slice(1); const r = JSON.parse(p);
      console.log(JSON.stringify({ ok: true, box, ref, commit: r.commit, runId: r.runId, url, ...(link ? { link } : {}) }))' "$preview" "$box" "$ref" "$url" "$link" ;;

  down)
    current=$(state)
    [ -n "$current" ] || { echo "instabox: no box named $box"; exit 0; }
    if [ -n "$if_ref" ]; then
      # exec wakes a box that paused itself when idle. One paused with down already has no preview.
      showing=$(instabox exec "$box" --timeout 30 -- 'cat ~/.occ-preview-ref 2>/dev/null' 2>/dev/null)
      if [ "$showing" != "$if_ref" ]; then
        echo "instabox: $box is not showing $if_ref (it shows ${showing:-nothing}); left as it is" >&2
        exit 0
      fi
    fi
    if [ "$(state)" = running ]; then
      instabox exec "$box" --timeout 300 -- 'rm -f ~/.occ-preview-ref; cd ~/OpenChessCoach 2>/dev/null && bash scripts/sandbox/clean.sh' >&2 \
        || echo "instabox: cleaning $box failed; the next preview cleans it first" >&2
    fi
    instabox port unpublish "$box" "$port" >/dev/null 2>&1 || true
    if [ "$delete" = 1 ]; then
      instabox rm --yes "$box" >&2
    elif [ "$pause" = 1 ]; then
      instabox suspend "$box" >&2
    else
      echo "instabox: the preview on $box is down; the box stays on for other work and pauses itself when idle" >&2
    fi ;;

  status)
    current=$(state)
    [ -n "$current" ] || { echo "instabox: no box named $box"; exit 0; }
    echo "instabox: $box is $current"
    if [ "$current" = running ]; then
      instabox exec "$box" --timeout 30 -- 'echo "instabox: showing $(cat ~/.occ-preview-ref 2>/dev/null || echo nothing); disk $(df -h --output=used,size,pcent /data | tail -1)"' 2>/dev/null
    fi
    instabox port ls "$box" --output table 2>/dev/null ;;

  *) usage ;;
esac
