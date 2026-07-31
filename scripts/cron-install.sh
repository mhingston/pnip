#!/usr/bin/env bash
# scripts/cron-install.sh
#
# Install (or remove) the PNIP cron entries. Idempotent: re-running
# `install` updates the entries in place; re-running `remove` is a
# no-op once the entries are gone.
#
# Usage:
#   scripts/cron-install.sh install [--user <name>] [--schedule "..."]
#   scripts/cron-install.sh remove  [--user <name>]
#   scripts/cron-install.sh show    [--user <name>]
#   scripts/cron-install.sh --help
#
# Target user:
#   By default the script installs into the crontab of the user that
#   invoked it. When invoked under `sudo`, it defaults to the invoking
#   user (SUDO_USER) instead, so `sudo scripts/cron-install.sh install`
#   from an operator shell installs into the operator's crontab rather
#   than root's. Override with --user <name> for explicit control.
#
#   The target user should be the operator whose $HOME holds the
#   per-user CLI installs (fabric, markitdown, etc.). Running cron
#   under a different user (e.g. root) means those CLIs are not in
#   the script's $PATH and worker spawns fail with ENOENT.
#
# The default schedule:
#   */10 * * * *   digest-drain          (drain Miniflux -> editions)
#   */10 * * * *   notebook-drain       (resume NotebookLM source ingestion)
#   */10 * * * *   podcast-drain        (resume ready NotebookLM podcasts)
#   0 */6 * * *    maintenance apply    (queue + 30-day retention cleanup)
#   0 6 * * *      daily-publish         (publication at 06:00 local)
#
# To customise the publication time:
#   scripts/cron-install.sh install --schedule-publish "30 5 * * *"
#   scripts/cron-install.sh install --schedule-drain "*/15 * * * *"
#   scripts/cron-install.sh install --schedule-notebook "*/15 * * * *"
#   scripts/cron-install.sh install --schedule-podcast "*/15 * * * *"
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
SCHEDULE_NOTEBOOK="*/10 * * * *"
SCHEDULE_PODCAST="*/10 * * * *"
SCHEDULE_MAINTENANCE="0 */6 * * *"
SCHEDULE_PUBLISH="0 6 * * *"
ACTION=""
TARGET_USER=""

usage() {
  sed -n '2,30p' "$0"
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    install|remove|show|--help|-h) ACTION="${1#--}"; [ "$ACTION" = "help" ] && usage; shift ;;
    --user) TARGET_USER="$2"; shift 2 ;;
    --schedule-drain) SCHEDULE_DRAIN="$2"; shift 2 ;;
    --schedule-notebook) SCHEDULE_NOTEBOOK="$2"; shift 2 ;;
    --schedule-podcast) SCHEDULE_PODCAST="$2"; shift 2 ;;
    --schedule-maintenance) SCHEDULE_MAINTENANCE="$2"; shift 2 ;;
    --schedule-publish) SCHEDULE_PUBLISH="$2"; shift 2 ;;
    --project-dir) PROJECT_DIR="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

[ -z "$ACTION" ] && { echo "action required: install | remove | show" >&2; exit 1; }

CURRENT_USER="$(id -un)"
if [ -z "$TARGET_USER" ]; then
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    TARGET_USER="$SUDO_USER"
  else
    TARGET_USER="$CURRENT_USER"
  fi
fi
if ! id -u "$TARGET_USER" >/dev/null 2>&1; then
  echo "error: target user '$TARGET_USER' does not exist" >&2
  exit 1
fi
if [ "$TARGET_USER" = "root" ] && [ "$CURRENT_USER" != "root" ]; then
  echo "warning: installing PNIP cron entries into root's crontab." >&2
  echo "         the PNIP scripts assume the operator's \$HOME/.local/bin" >&2
  echo "         (fabric, markitdown, ...); cron-as-root will fail to" >&2
  echo "         spawn those CLIs. Re-run with --user <operator> if this" >&2
  echo "         is unintended." >&2
fi

run_crontab() {
  if [ "$TARGET_USER" = "$CURRENT_USER" ]; then
    crontab "$@"
  else
    sudo -n -u "$TARGET_USER" crontab "$@"
  fi
}

TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
if [ -z "$TARGET_HOME" ]; then
  echo "error: could not resolve home directory for '$TARGET_USER'" >&2
  exit 1
fi

DRAIN_SCRIPT="$PROJECT_DIR/scripts/digest-drain.sh"
NOTEBOOK_SCRIPT="$PROJECT_DIR/scripts/notebook-drain.sh"
PODCAST_SCRIPT="$PROJECT_DIR/scripts/podcast-drain.sh"
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
# Target user: $TARGET_USER (HOME=$TARGET_HOME)
#
# Local time: crontab fires entries on the system clock's local
# time, which is the operator's local time. The daily publish
# sequence uses the local date as the edition date.
#
# PATH: cron runs with a minimal PATH by default. The PNIP scripts
# set their own PATH internally (with the operator's \$HOME/.local/bin
# prepended so fabric, markitdown, etc. are findable). This PATH=
# line is a safety net for any future inline command that may need
# it, and also covers the case where cron strips HOME from the
# environment.
PATH=$TARGET_HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Drain Miniflux -> editions. Idempotent. Tight interval.
$SCHEDULE_DRAIN $DRAIN_SCRIPT >> $PROJECT_DIR/logs/digest-drain.log 2>&1

# Resume NotebookLM podcasts only after their notebooks are ready.
$SCHEDULE_PODCAST $PODCAST_SCRIPT >> $PROJECT_DIR/logs/podcast-drain.log 2>&1

# Resume NotebookLM source ingestion after publication. This is separate from
# daily-publish so provider readiness never delays the edition.
$SCHEDULE_NOTEBOOK $NOTEBOOK_SCRIPT >> $PROJECT_DIR/logs/notebook-drain.log 2>&1

# Queue cleanup and 30-day data retention. The command is idempotent and
# bounded by the CLI's --limit safety cap.
$SCHEDULE_MAINTENANCE cd $PROJECT_DIR && $PROJECT_DIR/node_modules/.bin/tsx $PROJECT_DIR/src/cli/index.ts maintenance --apply --retention-after 30d >> $PROJECT_DIR/logs/maintenance.log 2>&1

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
  if run_crontab -l >/dev/null 2>&1; then
    run_crontab -l > "$dest" 2>/dev/null || true
    echo "Backed up current crontab ($TARGET_USER) to $dest"
  else
    echo "(no existing crontab for $TARGET_USER; nothing to back up)" > "$dest"
  fi
}

remove_block() {
  local current
  if ! current="$(run_crontab -l 2>/dev/null)"; then
    echo "(no crontab for $TARGET_USER; nothing to remove)"
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
    run_crontab -r 2>/dev/null || true
    echo "Removed crontab for $TARGET_USER (was only PNIP entries)"
  else
    printf '%s\n' "$filtered" | run_crontab -
    echo "Removed PNIP cron block from $TARGET_USER's crontab"
  fi
}

install_block() {
  backup_crontab
  remove_block
  local current
  current="$(run_crontab -l 2>/dev/null || true)"
  local fragment
  fragment="$(build_fragment)"
  if [ -z "$current" ]; then
    printf '%s\n' "$fragment" | run_crontab -
  else
    printf '%s\n%s\n' "$current" "$fragment" | run_crontab -
  fi
  echo "Installed PNIP cron block into $TARGET_USER's crontab"
  echo
  echo "Current crontab for $TARGET_USER:"
  run_crontab -l | sed -n "/$PNIP_TAG/,/$PNIP_TAG/p"
}

show_block() {
  if run_crontab -l 2>/dev/null | grep -q "$PNIP_TAG"; then
    run_crontab -l | sed -n "/$PNIP_TAG/,/$PNIP_TAG/p"
  else
    echo "(no PNIP cron block installed for $TARGET_USER)"
  fi
}

case "$ACTION" in
  install) install_block ;;
  remove)  backup_crontab; remove_block ;;
  show)    show_block ;;
  *)       echo "unknown action: $ACTION" >&2; exit 1 ;;
esac
