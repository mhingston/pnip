#!/usr/bin/env bash
# scripts/cron-install.sh
#
# Install (or remove) the PNIP cron entries. Idempotent: re-running
# `install` updates the entries in place; re-running `remove` is a
# no-op once the entries are gone.
#
# Usage:
#   scripts/cron-install.sh install [--schedule "..."]
#   scripts/cron-install.sh remove
#   scripts/cron-install.sh show
#   scripts/cron-install.sh --help
#
# The default schedule:
#   */10 * * * *   digest-drain          (drain Miniflux -> editions)
#   0 */6 * * *    maintenance dry-run   (queue health preview)
#   0 6 * * *      daily-publish         (publication at 06:00 local)
#
# To customise the publication time:
#   scripts/cron-install.sh install --schedule-publish "30 5 * * *"
#   scripts/cron-install.sh install --schedule-drain "*/15 * * * *"
#   scripts/cron-install.sh install --schedule-maintenance "0 */4 * * *"
#
# The script tags every line it adds with "# pnip-managed" so the
# `remove` action can be precise (other cron entries are untouched).
#
# Exit codes:
#   0  success
#   1  invalid arguments
#   2  crontab command failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

PNIP_TAG="# pnip-managed"

# Defaults (overridable via flags)
SCHEDULE_DRAIN="*/10 * * * *"
SCHEDULE_MAINTENANCE="0 */6 * * *"
SCHEDULE_PUBLISH="0 6 * * *"
ACTION=""

usage() {
  sed -n '2,30p' "$0"
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    install|remove|show|--help|-h) ACTION="${1#--}"; [ "$ACTION" = "help" ] && usage; shift ;;
    --schedule-drain) SCHEDULE_DRAIN="$2"; shift 2 ;;
    --schedule-maintenance) SCHEDULE_MAINTENANCE="$2"; shift 2 ;;
    --schedule-publish) SCHEDULE_PUBLISH="$2"; shift 2 ;;
    --project-dir) PROJECT_DIR="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

[ -z "$ACTION" ] && { echo "action required: install | remove | show" >&2; exit 1; }

DRAIN_SCRIPT="$PROJECT_DIR/scripts/digest-drain.sh"
PUBLISH_SCRIPT="$PROJECT_DIR/scripts/daily-publish.sh"

# The crontab fragment. PARTITION_CONFIG and NOTEBOOKLM_MAX_SOURCES_PER_NOTEBOOK
# are read from the operator's .env by the scripts themselves (via
# scripts/load-env.mjs) so the schedule reflects the current partition
# configuration. We do not set any env vars in the crontab.
build_fragment() {
  cat <<EOF
# --- BEGIN $PNIP_TAG ---
# PNIP cron entries. Edits to this block are safe; the install
# script rewrites it on every run. Run
#   scripts/cron-install.sh remove
# to delete the block entirely.
#
# Local time: crontab fires entries on the system clock's local
# time, which is the operator's local time. The daily publish
# sequence uses the local date as the edition date.
#
# PATH: cron runs with a minimal PATH by default. The PNIP scripts
# set their own PATH internally (with the operator's $HOME/.local/bin
# prepended so fabric, markitdown, etc. are findable). This PATH=
# line is a safety net for any future inline command that may need
# it, and also covers the case where cron strips HOME from the
# environment.
PATH=/root/.local/bin:/home/mark/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Drain Miniflux -> editions. Idempotent. Tight interval.
$SCHEDULE_DRAIN $DRAIN_SCRIPT >> $PROJECT_DIR/logs/digest-drain.log 2>&1

# Cheap queue-health preview. The full maintenance --apply runs daily
# after publication (separate cron in the README).
$SCHEDULE_MAINTENANCE cd $PROJECT_DIR && $PROJECT_DIR/node_modules/.bin/tsx $PROJECT_DIR/src/cli/index.ts maintenance >> $PROJECT_DIR/logs/maintenance.log 2>&1

# Daily publication. The script itself sequences the steps; cron just
# fires the trigger at the operator's local publication time.
$SCHEDULE_PUBLISH $PUBLISH_SCRIPT >> $PROJECT_DIR/logs/daily-publish.log 2>&1

# --- END $PNIP_TAG ---
EOF
}

# Backup the current crontab before any modification. We write to a
# timestamped file under $PROJECT_DIR/logs so the operator can find it.
backup_crontab() {
  local dest="$PROJECT_DIR/logs/crontab.backup.$(date +%Y%m%dT%H%M%S).txt"
  if crontab -l >/dev/null 2>&1; then
    crontab -l > "$dest" 2>/dev/null || true
    echo "Backed up current crontab to $dest"
  else
    echo "(no existing crontab; nothing to back up)" > "$dest"
  fi
}

remove_block() {
  local current
  if ! current="$(crontab -l 2>/dev/null)"; then
    echo "(no crontab; nothing to remove)"
    return 0
  fi
  local filtered
  filtered="$(printf '%s\n' "$current" | awk -v tag="$PNIP_TAG" '
    /^# --- BEGIN / && $0 ~ tag { in_block = 1; next }
    /^# --- END /   && $0 ~ tag { in_block = 0; next }
    !in_block
  ')"
  if [ -z "$filtered" ]; then
    # crontab rejects empty input; remove the file entirely
    crontab -r 2>/dev/null || true
    echo "Removed crontab (was only PNIP entries)"
  else
    printf '%s\n' "$filtered" | crontab -
    echo "Removed PNIP cron block"
  fi
}

install_block() {
  backup_crontab
  remove_block
  local current
  current="$(crontab -l 2>/dev/null || true)"
  local fragment
  fragment="$(build_fragment)"
  if [ -z "$current" ]; then
    printf '%s\n' "$fragment" | crontab -
  else
    printf '%s\n%s\n' "$current" "$fragment" | crontab -
  fi
  echo "Installed PNIP cron block"
  echo
  echo "Current crontab:"
  crontab -l | sed -n "/$PNIP_TAG/,/$PNIP_TAG/p"
}

show_block() {
  if crontab -l 2>/dev/null | grep -q "$PNIP_TAG"; then
    crontab -l | sed -n "/$PNIP_TAG/,/$PNIP_TAG/p"
  else
    echo "(no PNIP cron block installed)"
  fi
}

case "$ACTION" in
  install) install_block ;;
  remove)  backup_crontab; remove_block ;;
  show)    show_block ;;
  *)       echo "unknown action: $ACTION" >&2; exit 1 ;;
esac
