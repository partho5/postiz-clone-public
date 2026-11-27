#!/bin/sh
# Forced command of the CI deploy key, in the deploy user's ~/.ssh/authorized_keys:
#   command="sh <checkout>/deploy/scripts/remote-deploy.sh <tier>",restrict ssh-ed25519 ... github-actions-deploy
# CI asks for "deploy <commit sha>". The checkout (a git clone of this repo) moves to that commit of origin/main, so the
# server's deploy files always match the repo; deploy/.env, backups/ and the volumes are not tracked and never touched.
# Then the deploy.sh of that commit runs with the image CI built from it (tag sha-<7 chars>). A plain "deploy" moves to
# the tip of origin/main and runs the image named in deploy/.env. One deploy runs at a time; each one's output is also
# kept in <checkout>/logs/.
# Usage: remote-deploy.sh <tier>        the request comes from SSH_ORIGINAL_COMMAND
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TIER="${1:-}"

# Prints a message to stderr and stops with a failure.
fail() {
  echo "remote-deploy: $*" >&2
  exit 1
}

[ -n "$TIER" ] || fail "usage: remote-deploy.sh <tier>"
# Split the request into words, with globbing off so a * in it stays a *.
set -f
# shellcheck disable=SC2086
set -- ${SSH_ORIGINAL_COMMAND:-deploy}
set +f
if [ "$1" != deploy ] || [ $# -gt 2 ]; then
  fail "unknown request; the only one is: deploy [<commit sha>]"
fi
SHA="${2:-}"
case "$SHA" in
  '') ;;
  *[!0-9a-f]*) fail "not a commit sha: $SHA" ;;
  *) [ ${#SHA} -ge 7 ] || fail "commit sha too short: $SHA" ;;
esac

exec 9>/tmp/smm-deploy.lock
flock 9

git -C "$ROOT" fetch --quiet origin main
TARGET=$(git -C "$ROOT" rev-parse --verify "${SHA:-origin/main}^{commit}") || fail "unknown commit $SHA"
git -C "$ROOT" merge-base --is-ancestor "$TARGET" origin/main || fail "$TARGET is not on origin/main"
# Deploys nothing when a tracked file was edited on the server (git would carry the edit along): put it in the repo.
git -C "$ROOT" diff --quiet HEAD -- ||
  fail "tracked files were edited on the server (git -C $ROOT status); move the change into the repo"
git -C "$ROOT" checkout --quiet --detach "$TARGET"
echo "remote-deploy: deploy files at $(git -C "$ROOT" log --oneline -1)"

TAG=""
[ -z "$SHA" ] || TAG="sha-$(printf '%.7s' "$TARGET")"

# deploy.sh runs in a session of its own with its output in a log file, so a dropped SSH connection (a cancelled CI
# job, a network blip) cannot stop it half way through a migration; this script only streams the log back. The lock
# stays held until deploy.sh ends (it inherits descriptor 9). The last 20 logs are kept.
mkdir -p "$ROOT/logs"
LOG="$ROOT/logs/deploy-$(date -u +%Y%m%d-%H%M%S).log"
# shellcheck disable=SC2086
setsid -w sh "$ROOT/deploy/scripts/deploy.sh" "$TIER" $TAG >"$LOG" 2>&1 </dev/null &
DEPLOY_PID=$!
tail -n +1 --pid="$DEPLOY_PID" -f "$LOG" || true
STATUS=0
wait "$DEPLOY_PID" || STATUS=$?
# shellcheck disable=SC2012
ls -1r "$ROOT"/logs/deploy-*.log | tail -n +21 | xargs -r rm -f
exit "$STATUS"
