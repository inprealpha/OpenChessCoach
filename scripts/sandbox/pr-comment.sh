#!/bin/bash
# Keeps the preview workflow's one comment on a PR: writes TEXT into it, or adds it. Only the bot's
# own comment that starts with the marker counts, so nobody else's comment gets edited. The text
# never holds a link: the preview's link holds the pairing code (ADR 0001).
#   REPO=owner/name PR=12 GH_TOKEN=… bash scripts/sandbox/pr-comment.sh "TEXT"

[ -n "${1:-}" ] && [[ "${PR:-}" =~ ^[0-9]+$ ]] && [[ "${REPO:-}" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] \
  || { echo "usage: REPO=owner/name PR=N bash scripts/sandbox/pr-comment.sh TEXT" >&2; exit 2; }
marker='<!-- preview -->'
body="$marker"$'\n'"$1"
id=$(gh api "repos/$REPO/issues/$PR/comments" --paginate \
  --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | startswith(\"$marker\"))) | .id" | head -n 1)
if [ -n "$id" ]; then
  gh api -X PATCH "repos/$REPO/issues/comments/$id" -f body="$body" > /dev/null
else
  gh api "repos/$REPO/issues/$PR/comments" -f body="$body" > /dev/null
fi
