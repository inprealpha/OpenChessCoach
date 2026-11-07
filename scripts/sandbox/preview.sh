#!/bin/bash
# Starts a preview of a checkout: installs its packages, builds the web app, starts a verify-mode run
# (seeded data, the fake Coach unless --real-coach) on a fixed port and checks it with coachctl
# doctor. A provider's script (instabox.sh) runs it on a box and gives the port a link.
#   bash scripts/sandbox/preview.sh [--repo DIR] [--sandbox] [--seed NAME] [--port N] [--real-coach]
#   bash scripts/sandbox/preview.sh --check-bubble [--repo DIR]
#     --repo DIR     the checkout to preview (default: the one this script is in). instabox.sh runs
#                    the base branch's copy of this script against the PR's checkout.
#     --sandbox      this machine is a sandbox: clean up earlier previews first (clean.sh), and run the
#                    branch's code inside a bubblewrap bubble (installed when missing). The bubble
#                    sees the checkout, an empty home and /tmp of its own, and the system's files
#                    read-only. It doesn't see this user's home folder, the machine's temp folder, its
#                    Secrets' placeholders, its other programs or the Docker socket, and it runs with
#                    none of this user's extra groups (such as docker). It shares the machine's
#                    network, so it can reach services on localhost. It needs sudo without a
#                    password: Linux lets only root give the bubble its own process list on a machine
#                    that mounts over files in /proc, as InstaBox boxes do. The branch's code still
#                    runs as this user, with no way back to root.
#     --real-coach   verify mode uses the real Coach: the bubble gets CLAUDE_CODE_OAUTH_TOKEN (on
#                    InstaBox, a Secret's placeholder) and nothing else of the machine's. Real usage.
#     --check-bubble only build the bubble and run its self-check (no install, no preview): the last
#                    line is {"ok":true} or {"ok":false,"error":"…"}. Every --sandbox preview runs the
#                    same check first.
# Progress goes to stderr. The last line on stdout is one JSON object:
#   {"ok":true,"runId":"run-…","port":8790,"coach":"fake","pairPath":"/#pair=CODE","commit":"…","doctor":{"ok":true,"failed":[]}}
# pairPath holds the pairing code: it goes only to the owner, never anywhere public (ADR 0001). It is
# there only when ok is true; a failure stops its run and reports only what failed.

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=
sandbox=0
seed=default
port=8790
coach=fake
check_only=0
usage() { echo "usage: bash scripts/sandbox/preview.sh [--repo DIR] [--sandbox] [--seed NAME] [--port N] [--real-coach] | --check-bubble [--repo DIR]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) [ -n "${2:-}" ] || usage; repo=$2; shift 2 ;;
    --sandbox) sandbox=1; shift ;;
    --seed) [[ "${2:-}" =~ ^[a-z-]+$ ]] || usage; seed=$2; shift 2 ;;
    --port) [[ "${2:-}" =~ ^[0-9]+$ ]] || usage; port=$2; shift 2 ;;
    --real-coach) coach=real; shift ;;
    --check-bubble) check_only=1; sandbox=1; shift ;;
    *) usage ;;
  esac
done

# One JSON line on stdout, then exit: 0 when ok, 1 otherwise.
result() {
  node -e 'const r = JSON.parse(process.argv[1]); console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1)' "$1"
  exit $?
}
# A failure names what went wrong and nothing else: no output of verify mode, which holds the code.
failure() {
  [ -z "${stop_bubble:-}" ] || $stop_bubble
  result "$(node -e 'console.log(JSON.stringify({ ok: false, error: process.argv[1] }))' "$1")"
}

cd "${repo:-$here/../..}" 2>/dev/null && [ -f package.json ] || failure "no checkout at ${repo:-$here/../..}"
repo=$(pwd)
commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
echo "preview: OpenChessCoach $commit in $repo, seed $seed, $coach Coach, port $port" >&2
if [ "$coach" = real ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  failure "the real Coach needs CLAUDE_CODE_OAUTH_TOKEN on this machine (on InstaBox, select the Claude Secret on the box)"
fi

# What runs the branch's code: directly on a desktop, inside a bubble on a sandbox.
if [ "$sandbox" = 1 ]; then
  [ "$check_only" = 1 ] || bash "$here/clean.sh" --sandbox --repo "$repo" || failure "the disk is too full for a preview: see the lines above"
  if ! command -v bwrap >/dev/null; then
    echo "preview: installing bubblewrap" >&2
    { sudo -n apt-get install -y -q bubblewrap || { sudo -n apt-get update -q && sudo -n apt-get install -y -q bubblewrap; }; } >/dev/null 2>&1 \
      || failure "bubblewrap is not installed and could not be installed (it needs sudo without a password)"
  fi
  sb=$HOME/.occ-preview-sandbox
  mkdir -p "$sb/home/.occ-out" "$sb/tmp"
  out=$sb/home/.occ-out
  inner_out=$HOME/.occ-out
  # The bubble: the whole system read-only; the home folder replaced by the bubble's own; the checkout
  # writable; its own /tmp; the box's temp folder and Secret placeholders hidden, but the proxy's CA
  # certificate kept, so HTTPS works; its own process list, so it can't read other programs'
  # environments. It keeps the network (npm installs, and the real Coach). Sockets that give root
  # (Docker's and other container engines') and the user's runtime folder (/run/user: its session bus
  # and any rootless engine) are covered up; the user's extra groups are dropped below as well.
  bubble=(sudo -n bwrap --ro-bind / / --dev /dev --proc /proc
    --bind "$sb/home" "$HOME" --bind "$sb/tmp" /tmp --bind "$repo" "$repo"
    --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup-try --new-session --die-with-parent
    --clearenv --setenv PATH /usr/local/bin:/usr/bin:/bin --setenv HOME "$HOME" --setenv TMPDIR /tmp
    --setenv LANG C.UTF-8 --setenv CI true --chdir "$repo")
  [ ! -d /data/tmp ] || bubble+=(--tmpfs /data/tmp)
  [ ! -d /run/user ] || bubble+=(--tmpfs /run/user)
  hidden=" "
  for s in /run/docker.sock /var/run/docker.sock /run/containerd/containerd.sock /run/podman/podman.sock /run/buildkit/buildkitd.sock; do
    [ -S "$s" ] || continue
    real=$(realpath "$s")
    case "$hidden" in *" $real "*) continue ;; esac
    hidden="$hidden$real "
    bubble+=(--ro-bind /dev/null "$real")
  done
  if [ -d /run/instabox/secrets ]; then
    bubble+=(--tmpfs /run/instabox/secrets)
    [ -z "${SSL_CERT_FILE:-}" ] || [ ! -f "$SSL_CERT_FILE" ] || bubble+=(--ro-bind "$SSL_CERT_FILE" "$SSL_CERT_FILE")
  fi
  for v in NODE_EXTRA_CA_CERTS SSL_CERT_FILE CURL_CA_BUNDLE REQUESTS_CA_BUNDLE; do
    [ -z "${!v:-}" ] || bubble+=(--setenv "$v" "${!v}")
  done
  [ "$coach" != real ] || bubble+=(--setenv CLAUDE_CODE_OAUTH_TOKEN "$CLAUDE_CODE_OAUTH_TOKEN")
  # bwrap runs as root to set the bubble up; everything inside runs as this user, in its own group
  # only (no docker or other extra groups), with no capabilities and no new privileges (bwrap sets that
  # flag, so sudo inside refuses).
  bubble+=(-- setpriv "--reuid=$(id -u)" "--regid=$(id -g)" --clear-groups --inh-caps=-all --bounding-set=-all)
  in_bubble() { "${bubble[@]}" bash -c "$1"; }

  # The self-check: the bubble is what it should be, or the branch's code never runs. It prints the
  # first thing that is wrong.
  check="gid=$(id -g); home='$HOME'"'
    [ "$(id -G)" = "$gid" ] || { echo "the bubble kept extra groups: $(id -G)"; exit 1; }
    grep -q "^NoNewPrivs:[[:space:]]*1" /proc/self/status || { echo "the bubble can gain privileges"; exit 1; }
    grep -q "^CapEff:[[:space:]]*0*$" /proc/self/status || { echo "the bubble has capabilities"; exit 1; }
    for s in /run/docker.sock /var/run/docker.sock /run/containerd/containerd.sock /run/podman/podman.sock /run/buildkit/buildkitd.sock; do
      [ ! -S "$s" ] || { echo "the bubble can reach $s"; exit 1; }
    done
    [ -z "$(ls -A /run/user 2>/dev/null)" ] || { echo "the bubble sees /run/user"; exit 1; }
    [ -z "$(ls -A /run/instabox/secrets 2>/dev/null | grep -v "^ca-bundle.pem$")" ] || { echo "the bubble sees the Secret placeholders"; exit 1; }
    [ -z "$(ls -A /data/tmp 2>/dev/null)" ] || { echo "the bubble sees /data/tmp"; exit 1; }
    [ ! -e "$home/.occ-preview-sandbox" ] || { echo "the bubble sees the home folder"; exit 1; }
    exit 0'
  why=$(in_bubble "$check" 2>&1) || failure "the bubble is not sealed: ${why:-bwrap failed to start it}"
  [ "$check_only" = 0 ] || result '{"ok":true}'
else
  out=$(mktemp -d)
  inner_out=$out
  in_bubble() { bash -c "$1"; }
  [ ! -d node_modules ] || npm run -s coachctl -- cleanup >/dev/null 2>&1
fi

# Install and build, as the branch's own package.json says.
in_bubble 'npm ci --no-audit --no-fund --loglevel=error && npm run -s build -w @chess-coach/web' >&2 \
  || failure "npm ci or the web build failed: see the lines above"

# Start verify mode and check it. On a sandbox this bubble stays open with the preview in it; clean.sh
# ends it, and everything the branch started with it.
rm -f "$out"/verify.json "$out"/doctor.json "$out"/done
flags="--seed $seed --port $port"
[ "$coach" != real ] || flags="$flags --real-coach"
start="npm run -s verify -- $flags > $inner_out/verify.json 2>/dev/null
  id=\$(node -e 'try { console.log(JSON.parse(require(\"fs\").readFileSync(process.argv[1], \"utf8\")).runId ?? \"\") } catch {}' $inner_out/verify.json)
  [ -z \"\$id\" ] || npm run -s coachctl -- doctor --run \"\$id\" > $inner_out/doctor.json 2>/dev/null
  touch $inner_out/done"
if [ "$sandbox" = 1 ]; then
  # 9>&-: instabox.sh holds the box's preview lock on file descriptor 9 while this script runs. The
  # bubble outlives the script, so it must not inherit that descriptor, or it would hold the lock for as
  # long as the preview runs.
  setsid "${bubble[@]}" bash -c "$start; exec sleep infinity # occ-preview-bubble" </dev/null >/dev/null 2>&1 9>&- &
  echo $! > "$sb/bubble.pid"
  stop_bubble="bash $here/clean.sh --sandbox --repo $repo --quiet"
else
  bash -c "$start"
  stop_bubble="npm run -s coachctl -- cleanup"
fi
for _ in $(seq 1 240); do [ -f "$out/done" ] && break; sleep 0.5; done
[ -f "$out/done" ] || failure "verify mode did not start within 2 minutes"

started=$(cat "$out/verify.json" 2>/dev/null)
run_id=$(node -e 'const r = JSON.parse(process.argv[1]); if (r.ok !== true || !r.runId) process.exit(1); console.log(r.runId)' "$started" 2>/dev/null)
if [ -z "$run_id" ]; then
  why=$(node -e 'const r = JSON.parse(process.argv[1]); console.log([r.error, r.fix].filter(Boolean).join(" "))' "$started" 2>/dev/null)
  failure "verify mode did not start${why:+: $why}"
fi
# A branch from before verify mode's --real-coach starts with the fake Coach: say so rather than pass.
ran=$(node -e 'console.log(JSON.parse(process.argv[1]).coach ?? "fake")' "$started" 2>/dev/null)
[ "$ran" = "$coach" ] || failure "this branch's verify mode can't use the real Coach (it is from before --real-coach)"

out_json=$(node -e '
  const [started, doctor, commit, coach] = process.argv.slice(1).map((a, i) => (i < 2 ? JSON.parse(a) : a));
  const failed = (doctor.checks ?? []).filter((c) => !c.ok).map((c) => String(c.name));
  // Doctor reports the state of the Coach without failing on it. A real-Coach preview is only
  // worth opening when the real Coach is ready (its login works inside the bubble).
  if (coach === "real") {
    const pairing = (doctor.checks ?? []).find((c) => c.name === "pairing");
    const state = /Coach (\w+)/.exec(String(pairing?.detail ?? ""))?.[1] ?? "unknown";
    if (state !== "ready") failed.push(`real-coach (${state})`);
  }
  const ok = doctor.ok === true && failed.length === 0;
  const r = { ok, runId: started.runId, port: Number(new URL(started.url).port), coach, commit, doctor: { ok, failed } };
  if (ok) r.pairPath = "/" + new URL(started.pairUrl).hash;
  else r.error = `doctor failed: ${failed.join(", ") || "no checks reported"}`;
  console.log(JSON.stringify(r));
' "$started" "$(cat "$out/doctor.json" 2>/dev/null)" "$commit" "$coach" 2>/dev/null) || failure "could not read the doctor output"
[ "$sandbox" = 1 ] || rm -rf "$out"

# A run that failed doctor doesn't stay up: nobody should reach a broken preview.
node -e 'process.exit(JSON.parse(process.argv[1]).ok ? 0 : 1)' "$out_json" || $stop_bubble >/dev/null 2>&1
result "$out_json"
