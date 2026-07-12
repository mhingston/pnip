#!/usr/bin/env bash
# scripts/podcast-drain.sh
#
# Resume optional NotebookLM podcasts after their edition notebook is ready.
# The command is safe to run frequently: generate-podcast is idempotent and
# the service resumes a persisted provider artifact instead of generating a
# duplicate when a podcast is already in progress.

set -euo pipefail

export PATH="$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

LOCK_FILE="/tmp/pnip-podcast-drain.lock"
exec 200>"$LOCK_FILE"
if ! flock --nonblock 200; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] another podcast drain is in progress (lock=$LOCK_FILE); exiting cleanly"
  exit 0
fi
trap 'flock --unlock 200 2>/dev/null || true; rm -f "$LOCK_FILE"' EXIT

DATE="${PNIP_PUBLISH_DATE:-$(date +%F)}"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$*"
}

if [ ! -f .env ]; then
  log "ERROR: .env not found at $PROJECT_DIR/.env"
  exit 1
fi
eval "$(node scripts/load-env.mjs)"

if [ -z "${DATABASE_URL:-}" ]; then
  log "ERROR: DATABASE_URL not set in .env"
  exit 1
fi

PARTITION_LINES="$(npm run --silent digestive -- active-partitions --date "$DATE" 2>/dev/null || true)"
if [ -z "$PARTITION_LINES" ]; then
  log "no active edition yet for date=$DATE; nothing to resume"
  exit 0
fi

run_effort() {
  local partition="$1"
  log "resuming podcast (date=$DATE partition=$partition)"
  if npm run digestive -- generate-podcast --date "$DATE" --partition "$partition" --wait; then
    log "podcast resume completed (date=$DATE partition=$partition)"
  else
    log "podcast not ready or failed (date=$DATE partition=$partition); will retry"
  fi
}

while IFS= read -r line; do
  [ -z "$line" ] && continue
  partition="${line%%:*}"
  tag="${line#*:}"
  if [ "$tag" = "with_podcast" ]; then
    run_effort "$partition"
  fi
done <<< "$PARTITION_LINES"
