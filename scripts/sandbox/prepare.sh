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

# The minimum Node.js version is package.json's engines.node (">=22.18").
if ! node -e '
  const want = require("./package.json").engines.node.replace(/^>=\s*/, "").split(".").map(Number);
  const have = process.versions.node.split(".").map(Number);
  const older = (have[0] - want[0] || have[1] - (want[1] ?? 0) || have[2] - (want[2] ?? 0)) < 0;
  if (older) { console.log("prepare: needs Node.js " + want.join(".") + " or later; found " + process.version); process.exit(1); }
'; then
  # The check prints why when Node.js is too old, and Node.js prints its own error when the check
  # itself fails (no node, or a package.json it can't read).
  command -v node >/dev/null || echo "prepare: needs Node.js; none found"
  echo "prepare: stopped before installing anything"
  exit "$strict"
fi

if npm ci --no-audit --no-fund; then
  # A sandbox image with browsers already in /opt/pw-browsers (Claude Code cloud) keeps them there;
  # elsewhere Playwright uses its own cache folder.
  if [ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ] && [ -d /opt/pw-browsers ]; then
    export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
    echo "prepare: Chromium goes in /opt/pw-browsers; Playwright finds it there only with PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers"
  fi
  # --no-install: only the Playwright version the lockfile pins, never the newest from the registry.
  npx --no-install playwright install chromium || fail "the Chromium install"
  npm run build -w @chess-coach/web || fail "the web build"
else
  fail "npm ci"
  echo "prepare: skipped the Chromium install and the web build, which need the dependencies"
fi

node scripts/sandbox/fetch-model.ts || fail "the Maia-3 model download"

if [ "$failed" = 1 ]; then
  echo "prepare: done, with failures (see above)"
  [ "$strict" = 1 ] && exit 1
else
  echo "prepare: done"
fi
exit 0
