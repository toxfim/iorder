#!/bin/sh
# Sends the COMMITTED tree of a git ref to the server and deploys it (uncommitted work never ships).
#   IORDER_SSH=user@host deploy/push.sh staging          # HEAD
#   IORDER_SSH=user@host deploy/push.sh prod v0.1.0      # a tag or commit
# The server address stays out of the repository: set IORDER_SSH (for example in ~/.ssh/config).
set -eu

ENV_NAME="${1:?usage: IORDER_SSH=user@host push.sh staging|prod [ref]}"
REF="${2:-HEAD}"
HOST="${IORDER_SSH:?set IORDER_SSH to user@host of the server}"

SHA="$(git rev-parse --short "$REF")"
DEST="/srv/iorder/src/$ENV_NAME-$SHA"

echo "== send $REF ($SHA) to $HOST:$DEST"
git archive --format=tar "$REF" | ssh "$HOST" "rm -rf '$DEST' && mkdir -p '$DEST' && tar -x -C '$DEST'"
ssh "$HOST" "sh '$DEST/deploy/deploy.sh' '$ENV_NAME'"
