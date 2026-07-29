#!/usr/bin/env bash
# scripts/daily-publish.sh
#
# Daily publication sequence. Run this at the operator's local
# publication time each day. The script is idempotent: re-running it
# is safe (PNIP commands are themselves idempotent), but the
# publication transition is one-way (building -> ready -> publishing
# -> published) so the second run against an already-published
# edition is a no-op.
#
# Local timezone:
#   The script uses the system clock's local date as the edition date.
#   Crontab fires the script at the operator's local time, so the
#   edition that gets published is the one for "today" in the
#   operator's local time. (If you need UTC dates, set
#   PNIP_PUBLISH_DATE=YYYY-MM-DD in the environment.)
#
# Sequence:
#   1. recover discovery if no edition exists for the date
#   2. digestive rollover-unenriched --date <date> (move unready docs to next
#      edition so the source can ship what is ready)
#   3. digestive generate-edition --date <date>   (building -> ready)
#   4. digestive generate-digest --date <date>     (master)
#   5. digestive generate-email --date <date>
#   6. digestive publish-edition --date <date> --dry-run
#   7. digestive publish-edition --date <date>
#
# NotebookLM ingestion and podcast generation continue after publication via
# notebook-drain.sh and podcast-drain.sh. They are optional artifacts and do
# not delay the edition email or publication transition.
#
# Environment:
#   PNIP_PUBLISH_DATE     override the edition date (default: today local)
#   PNIP_LOG_DIR          log directory (default: $PROJECT_DIR/logs)
#   PNIP_DRY_RUN          if set, stops after the dry-run gate check
#   PARTITION_CONFIG      JSON object used by the edition commands
#
# Exit codes:
#   0  publication completed successfully (or the edition was already
#      published and the script noticed)
#   non-zero  a step failed; the script aborts at the first failure
#      thanks to `set -e` and the `run` helper

set -euo pipefail

# Cron runs with a minimal PATH (typically /usr/bin:/bin). Build a
# PATH that covers the system defaults AND the operator's local bin
# directory, which is where third-party CLIs (fabric, notebooklm,
# markitdown, etc.) typically live on a per-user install.
export PATH="$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# Serialize concurrent invocations. The daily publish is a ~30 min
# sequence; if the operator runs the script manually while a cron
# is also firing (or the previous run is still draining), we want
# exactly one to proceed. flock --nonblock exits cleanly (exit 0)
# so the operator's manual run is the one that wins, and the cron
# no-ops.
LOCK_FILE="/tmp/pnip-daily-publish.lock"
exec 200>"$LOCK_FILE"
if ! flock --nonblock 200; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] another daily-publish is in progress (lock=$LOCK_FILE); exiting cleanly"
  exit 0
fi
BOUNDARY_LOCK_FILE="/tmp/pnip-edition-boundary.lock"

DATE="${PNIP_PUBLISH_DATE:-$(date +%F)}"
LOG_DIR="${PNIP_LOG_DIR:-$PROJECT_DIR/logs}"
LOG_FILE="$LOG_DIR/daily-publish-${DATE}.log"
DRY_RUN="${PNIP_DRY_RUN:-}"
PUBLISH_PROCESS_MAX_JOBS="${PNIP_PUBLISH_PROCESS_MAX_JOBS:-10000}"

mkdir -p "$LOG_DIR"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$*" | tee -a "$LOG_FILE"
}

# Discovery and processing take a shared lock in digest-drain.sh. The daily
# publication takes the same lock exclusively for the whole boundary so no
# document can arrive or be claimed between rollover, readiness evaluation,
# and the final publish transition.
exec 201>"$BOUNDARY_LOCK_FILE"
log "waiting for edition-boundary lock (lock=$BOUNDARY_LOCK_FILE)"
flock --exclusive 201
log "edition-boundary lock acquired"

trap 'flock --unlock 201 2>/dev/null || true; flock --unlock 200 2>/dev/null || true; rm -f "$LOCK_FILE"' EXIT

# run <description> <command...> — log + execute, abort on failure.
#
# The "best-effort" variant (`run_effort`) logs and continues on
# failure. Use it for pure fire-and-forget kickoffs where a transient
# provider failure should not abort the publication sequence.
run() {
  local desc="$1"
  shift
  log "-> $desc"
  if "$@"; then
    log "OK  $desc"
  else
    local rc=$?
    log "FAIL  $desc (exit $rc)"
    return $rc
  fi
}

# Load .env via the Node helper. Sourcing the file directly in bash
# is unsafe because some values (notably the EMAIL_FROM form) contain
# angle brackets. The helper uses dotenv and emits export-safe lines.
if [ ! -f .env ]; then
  log "ERROR: .env not found at $PROJECT_DIR/.env"
  exit 1
fi
eval "$(node scripts/load-env.mjs)"

if [ -z "${DATABASE_URL:-}" ]; then
  log "ERROR: DATABASE_URL not set in .env"
  exit 1
fi

# Resolve active partitions from the same database-backed rule used by the
# publication gate. This applies enabled + min_articles consistently. If the
# drain was busy during the overnight boundary, discover the missing date
# before continuing. The conditional is important: re-running publication for
# an already-published date must not make discover advance to tomorrow.
log "daily-publish starting (date=$DATE local)"
if ! PARTITION_LINES="$(npm run --silent digestive -- active-partitions --date "$DATE")"; then
  log "no usable edition found for $DATE; recovering it through discovery"
  run "discover missing edition" \
    npm run digestive -- discover --date "$DATE"
  PARTITION_LINES="$(npm run --silent digestive -- active-partitions --date "$DATE")"
fi
log "active partitions:"
while IFS= read -r line; do
  log "  - $line"
done <<< "$PARTITION_LINES"

# 1. Roll over unready documents to the next edition if the current one is not
# fully ready. A late enrichment, a missing story summary, or an unfinished
# cluster can all keep the readiness gate from succeeding at the publish
# deadline. Rolling the unready documents over lets today's edition ship what
# it has while preserving the unfinished work for tomorrow.
#
# The command is a no-op when the edition is fully ready, so it adds no
# latency on the happy path. We still let a non-zero exit abort the script so
# a database error does not silently slip through.
run "rollover-unenriched" \
  npm run digestive -- rollover-unenriched --date "$DATE"

run "finish current edition processing" \
  npm run digestive -- process --date "$DATE" --max-jobs "$PUBLISH_PROCESS_MAX_JOBS"

# 2. Evaluate the building -> ready transition before rendering the digest.
# The Markdown service intentionally refuses to render a building edition, so
# this gate must run before generate-digest. It is idempotent for ready and
# published editions.
run "generate-edition" \
  npm run digestive -- generate-edition --date "$DATE"

# 3. Markdown digest (master)
run "generate-digest" \
  npm run digestive -- generate-digest --date "$DATE"

# 4. Email is independent of NotebookLM artifacts. The command remains
# idempotent: an already-sent edition is not delivered twice.
run "generate-email" \
  npm run digestive -- generate-email --date "$DATE"

# 5. Dry-run gate check. If the gate fails, the script aborts BEFORE
# the real publish so the operator can investigate. The dry-run
# output is logged for audit.
run "publish-edition --dry-run" \
  npm run digestive -- publish-edition --date "$DATE" --dry-run

if [ -n "$DRY_RUN" ]; then
  log "PNIP_DRY_RUN is set; stopping before the real publish"
  log "daily-publish dry-run complete"
  exit 0
fi

# 6. Real publish
run "publish-edition" \
  npm run digestive -- publish-edition --date "$DATE"

log "daily-publish complete"
