#!/usr/bin/env bash
# scripts/digest-drain.sh
#
# Drains new Miniflux entries into PNIP and processes them. Designed to
# run on a tight cron (every 5-15 minutes) throughout the day. Both
# `discover` and `process` are idempotent, so overlapping or duplicate
# runs are safe.
#
# Logs to stdout (cron can pipe to a file or have its MTA deliver it).
# Exit codes:
#   0  all good
#   non-zero  a step failed; cron will email the operator

set -euo pipefail

# Cron runs with a minimal PATH (typically /usr/bin:/bin). Build a
# PATH that covers the system defaults AND the operator's local bin
# directory, which is where third-party CLIs (fabric, markitdown, the
# AI provider's CLI, etc.) typically live on a per-user install. The
# original problem this fixes: cron was running expansions that
# called `fabric` and failing with spawn fabric ENOENT because
# /home/<user>/.local/bin was not in cron's minimal PATH.
export PATH="$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$*"
}

# Serialize concurrent invocations via flock. Cron firing every 10
# min can race with a previous run that's still draining a large
# queue. flock --nonblock means a second invocation exits cleanly
# (exit 0) when the first is still running, so the operator's cron
# log doesn't fill up with "another drain is in progress" noise.
# The lock is held on a file descriptor and released automatically
# when the script exits.
LOCK_FILE="/tmp/pnip-digest-drain.lock"
exec 200>"$LOCK_FILE"
if ! flock --nonblock 200; then
  log "another drain is in progress (lock=$LOCK_FILE); exiting cleanly"
  exit 0
fi
trap 'flock --unlock 200 2>/dev/null || true; rm -f "$LOCK_FILE"' EXIT

if [ ! -f .env ]; then
  log "ERROR: .env not found at $PROJECT_DIR/.env"
  exit 1
fi

# Load .env via the Node helper. Sourcing the file directly in bash
# is unsafe (some values, like EMAIL_FROM, contain angle brackets).
eval "$(node scripts/load-env.mjs)"

if [ -z "${DATABASE_URL:-}" ]; then
  log "ERROR: DATABASE_URL not set in .env"
  exit 1
fi

log "discover starting"
npm run digestive -- discover
log "discover complete"

log "process starting"
npm run digestive -- process
log "process complete"
