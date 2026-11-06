#!/bin/bash
# Prepares a machine to develop, test and verify OpenChessCoach: the dependencies, the Chromium build
# the repo's Playwright pins, the web build and the Maia-3 model. One script for every sandbox
# (Claude Code cloud, InstaBox, Sailbox) and for a Mac or Linux desktop. It runs from any folder.
#   bash scripts/sandbox/prepare.sh            a failed step prints "prepare: ... failed" and the
#                                              rest still run; exits 0, so a cloud session still starts
#   bash scripts/sandbox/prepare.sh --strict   the same, but exits 1 if any step failed
# Not done here: Chromium's system libraries (npx playwright install-deps chromium, needs root).

strict=0
case "${1:-}" in
  '') ;;
  --strict) strict=1 ;;
  *) echo "usage: bash scripts/sandbox/prepare.sh [--strict]" >&2; exit 2 ;;
esac

failed=0
fail() {
  echo "prepare: $1 failed"
  failed=1
}

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || { echo "prepare: could not find the repository"; exit "$strict"; }
echo "prepare: OpenChessCoach in $(pwd)"

if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)' 2>/dev/null; then
  echo "prepare: needs Node.js 22.18 or later; found $(node --version 2>/dev/null || echo none)"
  exit "$strict"
fi

npm ci --no-audit --no-fund || fail "npm ci"

# A sandbox image with browsers already in /opt/pw-browsers (Claude Code cloud) keeps them there;
# elsewhere Playwright uses its own cache folder.
if [ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ] && [ -d /opt/pw-browsers ]; then
  export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
fi
npx playwright install chromium || fail "the Chromium install"

npm run build -w @chess-coach/web || fail "the web build"

node scripts/sandbox/fetch-model.ts || fail "the Maia-3 model download"

if [ "$failed" = 1 ]; then
  echo "prepare: done, with failures (see above)"
  [ "$strict" = 1 ] && exit 1
else
  echo "prepare: done"
fi
exit 0
