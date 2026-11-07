#!/bin/bash
# Decides what the preview workflow does for one GitHub event, from the environment the workflow sets:
#   EVENT        workflow_dispatch or pull_request_target
#   ACTION       opened, reopened, synchronize, edited, labeled or closed
#   LABELLED     true when the PR has the "preview" label; LABEL: the label just added
#   BODY         the PR's description; on an edit, BODY_CHANGED (true when the edit changed the
#                description) and BODY_BEFORE (the description before it)
#   SEED_INPUT, COACH_INPUT   workflow_dispatch's inputs
#   ENABLED      true when the repository's settings turn previews on (PREVIEW_PROVIDER)
# Prints action=up|down|skip|unavailable, seed=NAME and coach=fake|real.
# Previews happen only on request: the "preview" label, or a line "Preview: on" in the description
# (lines inside HTML comments never count, so the PR template's hints don't ask). A PR that asks gets
# a preview when it asks and again on every push; closing it takes the preview down. A request where
# previews aren't set up gives "unavailable", so the workflow can say so on the PR. "Preview seed:
# NAME" picks the seed, and "Preview coach: real" the real Coach.
#   EVENT=... ACTION=... bash scripts/sandbox/preview-decide.sh >> "$GITHUB_OUTPUT"

strip() { printf '%s\n' "$1" | tr -d '\r' | perl -0pe 's/<!--.*?-->//gs'; }
line() { strip "$1" | grep -qiE "^[[:space:]]*$2[[:space:]]*\$"; }
body=$(strip "${BODY:-}")
asks() { [ "${LABELLED:-}" = true ] || line "$1" 'preview:[[:space:]]*on'; }

seed=$(printf '%s\n' "$body" | grep -oiE '^[[:space:]]*preview seed:[[:space:]]*[a-z-]+' | head -n 1 |
  sed -E 's/^[^:]*:[[:space:]]*//' | tr 'A-Z' 'a-z')
coach=fake
line "${BODY:-}" 'preview coach:[[:space:]]*real' && coach=real

case "${EVENT:-}:${ACTION:-}" in
  workflow_dispatch:*)
    action=up
    seed=$(printf '%s' "${SEED_INPUT:-default}" | tr 'A-Z' 'a-z')
    [ "${COACH_INPUT:-}" = real ] && coach=real || coach=fake ;;
  *:closed) action=down ;;
  *:labeled) [ "${LABEL:-}" = preview ] && action=up || action=skip ;;
  # An edit asks only when it adds the request: pushes refresh a preview the PR already asked for.
  *:edited) if [ "${BODY_CHANGED:-}" = true ] && asks "${BODY:-}" && ! asks "${BODY_BEFORE:-}"; then action=up; else action=skip; fi ;;
  *:opened | *:reopened | *:synchronize) asks "${BODY:-}" && action=up || action=skip ;;
  *) action=skip ;;
esac
if [ "${ENABLED:-}" != true ]; then
  case "$action" in up) action=unavailable ;; down) action=skip ;; esac
fi
[[ "$seed" =~ ^[a-z-]+$ ]] || seed=default
echo "action=$action"
echo "seed=$seed"
echo "coach=$coach"
