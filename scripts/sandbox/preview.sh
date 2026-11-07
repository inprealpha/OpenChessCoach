#!/bin/bash
# Starts a preview of this checkout on the machine it runs on: prepares the machine, stops earlier
# verify-mode runs, starts a fresh one (fake Coach, seeded data) on a fixed port and checks it with
# coachctl doctor. The same on every sandbox; a provider's script (instabox.sh) runs it on a box and
# gives the port a link.
#   bash scripts/sandbox/preview.sh [--seed NAME] [--port N] [--no-prepare]
# Progress goes to stderr. The last line on stdout is one JSON object:
#   {"ok":true,"runId":"run-…","port":8790,"pairPath":"/#pair=CODE","commit":"…","doctor":{"ok":true,"failed":[]}}
# pairPath holds the pairing code: it goes only to the owner, never anywhere public (ADR 0001).

seed=default
port=8790
prepare=1
usage() { echo "usage: bash scripts/sandbox/preview.sh [--seed NAME] [--port N] [--no-prepare]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --seed) [ -n "${2:-}" ] || usage; seed=$2; shift 2 ;;
    --port) [[ "${2:-}" =~ ^[0-9]+$ ]] || usage; port=$2; shift 2 ;;
    --no-prepare) prepare=0; shift ;;
    *) usage ;;
  esac
done

# One JSON line on stdout, then exit: 0 when ok, 1 otherwise.
result() {
  node -e 'const r = JSON.parse(process.argv[1]); console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1)' "$1"
  exit $?
}
failure() { result "$(node -e 'console.log(JSON.stringify({ ok: false, error: process.argv[1] }))' "$1")"; }

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || { echo '{"ok":false,"error":"could not find the repository"}'; exit 1; }
commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
echo "preview: OpenChessCoach $commit in $(pwd), seed $seed, port $port" >&2

if [ "$prepare" = 1 ]; then
  bash scripts/sandbox/prepare.sh --strict >&2 || failure "prepare.sh failed: see the lines above"
fi

# Earlier previews on this machine: cleanup stops only verify-mode runs and deletes only their data.
npm run -s coachctl -- cleanup >&2 || echo "preview: cleanup of earlier runs failed; starting anyway" >&2

started=$(npm run -s verify -- --seed "$seed" --port "$port")
run_id=$(node -e 'const r = JSON.parse(process.argv[1]); if (!r.ok) process.exit(1); console.log(r.runId)' "$started" 2>/dev/null) \
  || failure "verify mode did not start: $started"
doctor=$(npm run -s coachctl -- doctor --run "$run_id")

result "$(node -e '
  const [started, doctor, commit] = process.argv.slice(1).map((a, i) => (i < 2 ? JSON.parse(a) : a));
  const failed = (doctor.checks ?? []).filter((c) => !c.ok).map((c) => c.name);
  console.log(JSON.stringify({
    ok: doctor.ok === true,
    runId: started.runId,
    port: Number(new URL(started.url).port),
    pairPath: "/" + new URL(started.pairUrl).hash,
    commit,
    doctor: { ok: doctor.ok === true, failed },
  }));
' "$started" "$doctor" "$commit" 2>/dev/null || echo '{"ok":false,"error":"could not read the verify or doctor output"}')"
