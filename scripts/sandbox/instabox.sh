#!/bin/bash
# The InstaBox adapter: runs a preview of a branch on an InstaBox box and gives it a link the owner
# can open on a phone. Runs where the instabox CLI is signed in (instabox login, or INSTABOX_API_KEY
# in CI). Previews use verify mode's fake Coach and fake data, and never run on a box with credentials.
#   bash scripts/sandbox/instabox.sh up [--ref BRANCH] [--seed NAME] [--box NAME] [--real-coach] [--notify]
#   bash scripts/sandbox/instabox.sh down [--box NAME] [--if-ref BRANCH] [--pause | --delete]
#   bash scripts/sandbox/instabox.sh status [--box NAME]
# up prints the link, with the pairing code in it, and ends with one JSON line. The link goes only to
# the owner (--notify sends it with telegram-notify, or with TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
# in CI), never into a PR or anywhere public (ADR 0001). In GitHub Actions, whose logs are public,
# the link is never printed, the JSON line has no link, and a failure reports only what failed.
# The branch's code runs inside a bubble on the box (preview.sh --sandbox), which sees none of the
# box's other files, Secrets or programs, so the box can be shared with other work and keep its
# Secrets. --real-coach hands the bubble the Claude Secret (PREVIEW_CLAUDE_SECRET, default
# CLAUDE_CODE_OAUTH_TOKEN), adding it to the box's selection when it isn't selected yet.
# down stops the preview and cleans the box (clean.sh); with --if-ref, only when the box is showing
# that branch (what the preview workflow does when a PR closes: the port stays published, with nothing
# behind it, for the next preview). Without --if-ref it also unpublishes the port. It leaves the box on
# for whatever else uses it (InstaBox pauses it after 30 idle minutes); --pause pauses it, --delete
# deletes it.
# The box: --box, else INSTABOX_PREVIEW_BOX, else occ-preview. up never removes or changes anything
# the box holds for other work.
# The scripts that run on the box (preview.sh, clean.sh) are this checkout's copies, not the branch's,
# and a lock on the box keeps a preview and a take-down from overlapping.

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
box=${INSTABOX_PREVIEW_BOX:-occ-preview}
repo=${OCC_REPO_URL:-https://github.com/inprealpha/OpenChessCoach.git}
port=8790
seed=default
ref=
notify=0
coach=fake
claude_secret=${PREVIEW_CLAUDE_SECRET:-CLAUDE_CODE_OAUTH_TOKEN}
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
    --real-coach) coach=real; shift ;;
    --delete) delete=1; shift ;;
    --pause) pause=1; shift ;;
    --if-ref) [ -n "${2:-}" ] || usage; if_ref=$2; shift 2 ;;
    *) usage ;;
  esac
done
# Names and refs go into a shell command on the box: only the characters git and instabox allow.
[[ "$box" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || { echo "instabox: box names are lowercase letters, digits and -" >&2; exit 2; }
[[ "$seed" =~ ^[a-z-]+$ ]] || usage
check_ref() { [[ "$1" =~ ^[A-Za-z0-9._/][A-Za-z0-9._/-]*$ ]] || { echo "instabox: that branch name has characters this script doesn't pass on" >&2; exit 2; }; }
[ -z "$ref" ] || check_ref "$ref"
[ -z "$if_ref" ] || check_ref "$if_ref"
[[ "$claude_secret" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "instabox: PREVIEW_CLAUDE_SECRET must be a Secret's name" >&2; exit 2; }
[[ "$repo" =~ ^https://[A-Za-z0-9./_-]+$ ]] || { echo "instabox: OCC_REPO_URL must be an https address" >&2; exit 2; }

command -v instabox >/dev/null || { echo "instabox: the instabox CLI is not installed: npx instabox@latest" >&2; exit 1; }

# Sets box_state to the box's state, or to "missing" when there is no such box. Any other failure
# (network, sign-in, the API) stops the script instead of passing for a missing box.
box_state=
read_state() {
  local out code
  out=$(instabox get "$box" --json 2>/dev/null)
  code=$?
  if [ "$code" = 4 ]; then box_state=missing; return; fi
  box_state=$(node -e 'const r = JSON.parse(process.argv[1]); if (!r.state) process.exit(1); console.log(r.state)' "$out" 2>/dev/null) \
    || { echo "instabox: could not read $box's state (instabox get exited $code)" >&2; exit 1; }
}

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

# Puts this checkout's preview.sh and clean.sh on the box, so a branch can't change how its own
# preview is checked or cleaned, and a branch from before these scripts still gets them.
tools=.occ-preview-tools
push_tools() {
  instabox exec "$box" --timeout 30 -- "mkdir -p ~/$tools" >/dev/null 2>&1 &&
    instabox push "$box" "$here/preview.sh" "/data/home/$tools/preview.sh" >/dev/null 2>&1 &&
    instabox push "$box" "$here/clean.sh" "/data/home/$tools/clean.sh" >/dev/null 2>&1 ||
    { echo "instabox: could not copy the preview scripts to $box" >&2; exit 1; }
}

# The lock every change to the preview on the box holds, so an up and a down never overlap. It is on
# file descriptor 9, which preview.sh closes for the bubble it leaves running.
# It waits 8 minutes at most, inside instabox exec's 10-minute limit, so a busy lock ends as the
# retryable 75 rather than as exec's timeout.
lock='exec 9>~/.occ-preview.lock; flock -w 480 9 || { echo "instabox: waited 8 minutes for another preview on this box" >&2; exit 75; }'

case "$command" in
  up)
    if [ -z "$ref" ]; then
      ref=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
      [ -n "$ref" ] && [ "$ref" != HEAD ] || { echo "instabox: no branch checked out here; pass --ref BRANCH" >&2; exit 2; }
      echo "instabox: previewing $ref as it is on GitHub (push it first if you have new commits)" >&2
    fi
    check_ref "$ref"

    read_state
    case "$box_state" in
      missing)
        echo "instabox: creating box $box" >&2
        if ! instabox create --name "$box" --secrets none >&2; then
          echo "instabox: could not create $box. On the free plan only one box exists at a time: see instabox ls, then pass --box with that name or delete it." >&2
          exit 1
        fi ;;
      running) ;;
      stopped) instabox start "$box" >&2 || exit 1 ;;
      *) instabox resume "$box" >&2 || instabox wake "$box" >&2 || exit 1 ;;
    esac

    # A real-Coach preview needs the Claude Secret selected on the box: add it to what is selected,
    # and wait until the box has it. Nothing else changes, and a preview never removes a Secret.
    if [ "$coach" = real ]; then
      delivery=$(instabox secrets show "$box" --json 2>/dev/null)
      selected=$(node -e 'console.log(JSON.stringify(JSON.parse(process.argv[1]).secrets ?? []))' "$delivery" 2>/dev/null) \
        || { echo "instabox: could not read $box's Secrets" >&2; exit 1; }
      if ! node -e 'process.exit(JSON.parse(process.argv[1]).includes(process.argv[2]) ? 0 : 1)' "$selected" "$claude_secret"; then
        instabox secrets ls --json 2>/dev/null | node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
            const v = JSON.parse(s); const list = Array.isArray(v) ? v : v.secrets ?? v.items ?? [];
            process.exit(list.some((x) => (x.name ?? x) === process.argv[1]) ? 0 : 1) })' "$claude_secret" \
          || { echo "instabox: the real Coach needs a Secret named $claude_secret in the InstaBox account (claude setup-token, then instabox secrets set $claude_secret --ai anthropic)" >&2; exit 1; }
        with=$(node -e 'console.log(JSON.stringify([...JSON.parse(process.argv[1]), process.argv[2]]))' "$selected" "$claude_secret")
        instabox secrets select "$box" --secrets "$with" >/dev/null && instabox secrets push "$box" >/dev/null \
          || { echo "instabox: could not select $claude_secret on $box" >&2; exit 1; }
        # The box gets the placeholder a moment later: wait until it says it has applied the selection.
        for _ in $(seq 1 30); do
          instabox secrets show "$box" --json 2>/dev/null | node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
              const g = JSON.parse(s).guest ?? {}; process.exit(g.appliedRevision >= g.revision ? 0 : 1) })' && break
          sleep 1
        done
        echo "instabox: selected $claude_secret on $box for the real Coach; it stays selected" >&2
      fi
    fi

    push_tools
    # The checkout and the preview, under the box's lock. InstaBox marks a failure of its own that is
    # worth repeating with exit code 75 (its API restarted, say): try once more, since a preview always
    # cleans up and starts afresh.
    for try in 1 2; do
      preview=$(instabox exec "$box" --timeout 600 -- "set -e
      $lock
      [ -d ~/OpenChessCoach/.git ] || git clone -q '$repo' ~/OpenChessCoach >&2
      cd ~/OpenChessCoach
      git fetch -q --depth 1 origin '$ref' >&2
      git checkout -q --force FETCH_HEAD >&2
      echo '$ref' > ~/.occ-preview-ref
      echo \"instabox: $box has $ref at \$(git rev-parse --short HEAD)\" >&2
      bash ~/$tools/preview.sh --repo ~/OpenChessCoach --sandbox --seed $seed --port $port$( [ "$coach" = fake ] || echo ' --real-coach')" | tail -n 1; exit "${PIPESTATUS[0]}")
      code=$?
      [ "$code" = 75 ] && [ "$try" = 1 ] || break
      echo "instabox: InstaBox asked to try again (exit 75); trying once more" >&2
      sleep 5
    done
    # Only what failed: the line may hold more than that, and CI logs are public.
    if ! node -e 'process.exit(JSON.parse(process.argv[1]).ok === true ? 0 : 1)' "$preview" 2>/dev/null; then
      why=$(node -e 'const r = JSON.parse(process.argv[1]); console.log(String(r.error ?? "").replace(/#pair=\S*/g, "#pair=…"))' "$preview" 2>/dev/null)
      echo "instabox: the preview of $ref did not start: ${why:-no result from the box}" >&2
      exit 1
    fi
    commit=$(node -e 'const c = String(JSON.parse(process.argv[1]).commit); if (!/^[0-9a-f]{7,40}$/.test(c)) process.exit(1); console.log(c)' "$preview") \
      || { echo "instabox: the preview reported no commit" >&2; exit 1; }

    url=$(instabox port ls "$box" --json 2>/dev/null | node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const ports = JSON.parse(s).ports ?? [];
        const p = ports.find((x) => Number(x.port) === Number(process.argv[1]));
        console.log(p?.url ?? "");
      })' "$port" 2>/dev/null)
    [ -n "$url" ] || url=$(instabox port publish "$box" "$port" --json 2>/dev/null | node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => console.log(JSON.parse(s).url ?? ""))' 2>/dev/null)
    [[ "$url" =~ ^https://[A-Za-z0-9.-]+/?$ ]] || { echo "instabox: could not publish port $port on $box" >&2; exit 1; }

    link=$(node -e 'console.log(process.argv[2].replace(/\/$/, "") + JSON.parse(process.argv[1]).pairPath)' "$preview" "$url")
    echo "instabox: preview of $ref at $commit on $box (seed $seed, $coach Coach), doctor passed" >&2
    [ "$ci" = 1 ] || echo "instabox: open $link" >&2
    if [ "$notify" = 1 ]; then
      if notify_owner "OpenChessCoach preview of $ref ($commit, seed $seed, $coach Coach): $link"; then
        echo "instabox: sent the link by Telegram" >&2
      elif [ "$ci" = 1 ]; then
        echo "instabox: could not send the link by Telegram, and CI logs are public, so it isn't printed here either" >&2
        exit 1
      else
        echo "instabox: could not send the link by Telegram; it is above" >&2
      fi
    fi
    [ "$ci" = 1 ] && link=
    node -e 'const [box, ref, commit, url, link] = process.argv.slice(1);
      console.log(JSON.stringify({ ok: true, box, ref, commit, coach: process.argv[6], url, ...(link ? { link } : {}) }))' "$box" "$ref" "$commit" "$url" "$link" "$coach" ;;

  down)
    read_state
    [ "$box_state" != missing ] || { echo "instabox: no box named $box" >&2; exit 0; }
    if [ "$box_state" != running ]; then
      # wake wakes a box that paused itself when idle (its preview would come back on the next request
      # to the link), and refuses one someone paused or stopped, whose preview isn't reachable.
      instabox wake "$box" >/dev/null 2>&1
      read_state
      [ "$box_state" = running ] || { echo "instabox: $box is $box_state, so its preview isn't reachable; left as it is" >&2; exit 0; }
    fi
    push_tools
    check=true
    [ -z "$if_ref" ] || check="[ \"\$(cat ~/.occ-preview-ref 2>/dev/null)\" = '$if_ref' ]"
    outcome=$(instabox exec "$box" --timeout 600 -- "$lock
      if ! $check; then echo \"not-showing \$(cat ~/.occ-preview-ref 2>/dev/null || echo nothing)\"; exit 0; fi
      rm -f ~/.occ-preview-ref
      if [ -d ~/OpenChessCoach ]; then bash ~/$tools/clean.sh --sandbox --repo ~/OpenChessCoach >&2 || echo 'instabox: cleaning failed; the next preview cleans first' >&2; fi
      echo down" | tail -n 1)
    case "$outcome" in
      down) ;;
      not-showing*) echo "instabox: $box is not showing $if_ref (it shows ${outcome#not-showing }); left as it is" >&2; exit 0 ;;
      *) echo "instabox: could not take the preview on $box down" >&2; exit 1 ;;
    esac
    [ -n "$if_ref" ] || instabox port unpublish "$box" "$port" >/dev/null 2>&1 || true
    if [ "$delete" = 1 ]; then
      instabox rm --yes "$box" >&2
    elif [ "$pause" = 1 ]; then
      instabox suspend "$box" >&2
    else
      echo "instabox: the preview on $box is down; the box stays on for other work and pauses itself when idle" >&2
    fi ;;

  status)
    read_state
    [ "$box_state" != missing ] || { echo "instabox: no box named $box"; exit 0; }
    echo "instabox: $box is $box_state"
    if [ "$box_state" = running ]; then
      instabox exec "$box" --timeout 30 -- 'echo "instabox: showing $(cat ~/.occ-preview-ref 2>/dev/null || echo nothing); disk $(df -h --output=used,size,pcent /data | tail -1)"' 2>/dev/null
    fi
    instabox port ls "$box" --output table 2>/dev/null ;;
esac
