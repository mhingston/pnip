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
#   1. digestive generate-digest --date <date>     (master)
#   2. for each active partition (master + configured):
#        kick off generate-notebook --partition <key> in fire-and-forget
#        kick off generate-podcast  --partition <key> in fire-and-forget (master and with_podcast partitions)
#   3. for each active partition:
#        wait on the notebook via --wait
#        wait on the podcast  via --wait (master and with_podcast partitions)
#   4. digestive generate-email --date <date> (with artifact links)
#   5. digestive publish-edition --date <date> --dry-run
#   6. digestive publish-edition --date <date>
#
# Environment:
#   PNIP_PUBLISH_DATE     override the edition date (default: today local)
#   PNIP_LOG_DIR          log directory (default: $PROJECT_DIR/logs)
#   PNIP_DRY_RUN          if set, stops after the dry-run gate check
#   PARTITION_CONFIG      JSON object (forwarded to all PNIP commands)
#   NOTEBOOKLM_MAX_SOURCES_PER_NOTEBOOK
#                         forwarded to generate-notebook
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
trap 'flock --unlock 200 2>/dev/null || true; rm -f "$LOCK_FILE"' EXIT

DATE="${PNIP_PUBLISH_DATE:-$(date +%F)}"
LOG_DIR="${PNIP_LOG_DIR:-$PROJECT_DIR/logs}"
LOG_FILE="$LOG_DIR/daily-publish-${DATE}.log"
DRY_RUN="${PNIP_DRY_RUN:-}"

mkdir -p "$LOG_DIR"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$*" | tee -a "$LOG_FILE"
}

# run <description> <command...> — log + execute, abort on failure.
#
# The "best-effort" variant (`run_effort`) logs and continues on
# failure. Use it for steps that are pure fire-and-forget kickoffs
# (notebook/podcast upload starts) where a transient failure (e.g.,
# the notebook is still in 'pending' from a previous run, so the
# podcast can't be kicked off yet) should not abort the whole
# sequence — the wait phase will retry.
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

run_effort() {
  local desc="$1"
  shift
  log "-> $desc (best-effort)"
  if "$@"; then
    log "OK  $desc"
    return 0
  else
    local rc=$?
    log "WARN  $desc (exit $rc, continuing)"
    return 0
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
# publication gate. This applies enabled + min_articles consistently.
log "daily-publish starting (date=$DATE local)"
PARTITION_LINES="$(npm run --silent digestive -- active-partitions --date "$DATE")"
log "active partitions:"
while IFS= read -r line; do
  log "  - $line"
done <<< "$PARTITION_LINES"

# 1. Markdown digest (master)
run "generate-digest" \
  npm run digestive -- generate-digest --date "$DATE"

# 2. Kick off per-partition notebook + podcast (fire-and-forget) so the
# upload work happens in parallel with the master notebook. Each
# generate-* call is idempotent: if a row already exists in the
# requested state, it is returned as-is and no second upload is made.
# The kickoff is best-effort: a failure here (e.g., the notebook is
# still 'pending' from a previous run) is not fatal — the wait phase
# retries by polling the existing row.
while IFS= read -r line; do
  [ -z "$line" ] && continue
  partition="${line%%:*}"
  tag="${line#*:}"
  run_effort "kickoff notebook (partition=$partition)" \
    env PARTITION_CONFIG="${PARTITION_CONFIG:-}" \
    npm run digestive -- generate-notebook --date "$DATE" --partition "$partition"
  if [ "$tag" = "with_podcast" ]; then
    run_effort "kickoff podcast (partition=$partition)" \
      env PARTITION_CONFIG="${PARTITION_CONFIG:-}" \
      npm run digestive -- generate-podcast --date "$DATE" --partition "$partition"
  fi
done <<< "$PARTITION_LINES"

# 3. Wait for each partition's notebook (and podcast, where applicable)
# to be ready. --wait blocks on the NotebookLM API; this is the
# wall-clock heavy step (~10-20 min per source typical). The wait
# phase is fatal: a real failure here stops the script.
while IFS= read -r line; do
  [ -z "$line" ] && continue
  partition="${line%%:*}"
  tag="${line#*:}"
  run "wait notebook (partition=$partition)" \
    env PARTITION_CONFIG="${PARTITION_CONFIG:-}" \
    npm run digestive -- generate-notebook --date "$DATE" --partition "$partition" --wait
  if [ "$tag" = "with_podcast" ]; then
    run "wait podcast (partition=$partition)" \
      env PARTITION_CONFIG="${PARTITION_CONFIG:-}" \
      npm run digestive -- generate-podcast --date "$DATE" --partition "$partition" --wait
  fi
done <<< "$PARTITION_LINES"

# 4. Email is rendered only after artifact waits complete so its Explore
# section can link to every ready notebook and podcast. The command remains
# idempotent: an already-sent edition is not delivered twice.
run "generate-email" \
  npm run digestive -- generate-email --date "$DATE"

# 5. Evaluate the building -> ready transition. The edition is in
# 'building' state once all 5 enrichers are done for every document
# in the partition and the cluster_stories + summarize_story
# workers have completed. generate-edition runs the readiness gate
# and transitions the edition to 'ready' (or leaves it in
# 'building' if the gate is not yet met).
run "generate-edition" \
  npm run digestive -- generate-edition --date "$DATE"

# 6. Dry-run gate check. If the gate fails, the script aborts BEFORE
# the real publish so the operator can investigate. The dry-run
# output is logged for audit.
run "publish-edition --dry-run" \
  npm run digestive -- publish-edition --date "$DATE" --dry-run

if [ -n "$DRY_RUN" ]; then
  log "PNIP_DRY_RUN is set; stopping before the real publish"
  log "daily-publish dry-run complete"
  exit 0
fi

# 7. Real publish
run "publish-edition" \
  npm run digestive -- publish-edition --date "$DATE"

log "daily-publish complete"
