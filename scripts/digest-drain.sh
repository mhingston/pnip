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

# Discovery and processing have separate locks. Processing can legitimately
# take many hours when a provider is rate-limited; it must not prevent the
# next cron tick from discovering the next day's edition.
DISCOVER_LOCK_FILE="/tmp/pnip-digest-discover.lock"
PROCESS_LOCK_FILE="/tmp/pnip-digest-process.lock"
DRAIN_MAX_JOBS="${PNIP_DRAIN_MAX_JOBS:-100}"
DRAIN_DATE="$(date +%F)"

run_discovery() (
  exec 200>"$DISCOVER_LOCK_FILE"
  if ! flock --nonblock 200; then
    log "another discovery is in progress (lock=$DISCOVER_LOCK_FILE); skipping discovery"
    exit 0
  fi
  trap 'flock --unlock 200 2>/dev/null || true; rm -f "$DISCOVER_LOCK_FILE"' EXIT

  log "discover starting (date=$DRAIN_DATE)"
  npm run digestive -- discover --date "$DRAIN_DATE"
  log "discover complete (date=$DRAIN_DATE)"
)

run_process() (
  exec 201>"$PROCESS_LOCK_FILE"
  if ! flock --nonblock 201; then
    log "another bounded process batch is in progress (lock=$PROCESS_LOCK_FILE); skipping processing"
    exit 0
  fi
  trap 'flock --unlock 201 2>/dev/null || true; rm -f "$PROCESS_LOCK_FILE"' EXIT

  log "process starting (date=$DRAIN_DATE, max_jobs=$DRAIN_MAX_JOBS)"
  npm run digestive -- process --date "$DRAIN_DATE" --max-jobs "$DRAIN_MAX_JOBS"
  log "process complete (date=$DRAIN_DATE)"
)

run_discovery
run_process
