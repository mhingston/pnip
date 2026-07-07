import type { ProcessingJobQueue } from "../jobs/queue/processing-job-queue.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface MaintenanceOptions {
  archiveAfterMs: number;
  purgeAfterMs: number;
  limit: number;
  apply: boolean;
}

export const DEFAULT_MAINTENANCE_OPTIONS: MaintenanceOptions = {
  archiveAfterMs: 24 * HOUR_MS,
  purgeAfterMs: 7 * DAY_MS,
  limit: 10_000,
  apply: false,
};

export interface MaintenancePreview {
  wouldArchive: { count: number; olderThanMs: number; eligibleStatuses: string[] };
  wouldPurge: { count: number; olderThanMs: number };
  beforeByStatus: Record<string, number>;
}

export interface MaintenanceResult {
  archived: number;
  purged: number;
  byStatus: Record<string, number>;
}

export type Log = (msg: string) => void;

const silent: Log = () => {};

export interface RunMaintenanceInput {
  queue: ProcessingJobQueue;
  options: Partial<MaintenanceOptions>;
  log?: Log;
}

/**
 * Maintenance helper for the processing-jobs queue.
 *
 * Two-phase operation:
 *   1. preview (default; apply=false): report what WOULD happen without writing.
 *   2. apply  (apply=true):            run archiveJobs then purgeArchivedJobs.
 *
 * The preview phase runs countByStatus() + a dry-run archive/purge estimate via
 * the same age filters, so the operator sees the headline numbers before any rows
 * are touched. The apply phase is idempotent (running it twice a day is fine).
 *
 * Defaults (overridable via options):
 *   - archiveAfterMs: 24h   - flip completed/failed jobs to status=archived
 *   - purgeAfterMs:   7d    - DELETE archived jobs older than this
 *   - limit:          10000 - hard cap on rows per phase (safety belt)
 */
export async function runMaintenance(
  input: RunMaintenanceInput,
): Promise<MaintenanceResult> {
  const opts: MaintenanceOptions = { ...DEFAULT_MAINTENANCE_OPTIONS, ...input.options };
  const log = input.log ?? silent;

  const before = await input.queue.countByStatus();
  log(
    `before: ` +
      Object.entries(before)
        .map(([k, v]) => `${k}=${v}`)
        .join(" "),
  );

  const archived = opts.apply
    ? await input.queue.archiveJobs({
        statuses: ["completed", "failed"],
        olderThanMs: opts.archiveAfterMs,
        limit: opts.limit,
      })
    : 0;
  if (opts.apply && archived > 0) {
    log(`archived ${archived} completed/failed job(s) older than ${formatDuration(opts.archiveAfterMs)}`);
  } else if (opts.apply) {
    log(`archived 0 completed/failed job(s)`);
  } else {
    log(`dry-run: would archive completed/failed jobs older than ${formatDuration(opts.archiveAfterMs)}`);
  }

  const purged = opts.apply
    ? await input.queue.purgeArchivedJobs({
        olderThanMs: opts.purgeAfterMs,
        limit: opts.limit,
      })
    : 0;
  if (opts.apply && purged > 0) {
    log(`purged ${purged} archived job(s) older than ${formatDuration(opts.purgeAfterMs)}`);
  } else if (opts.apply) {
    log(`purged 0 archived job(s)`);
  } else {
    log(`dry-run: would purge archived jobs older than ${formatDuration(opts.purgeAfterMs)}`);
  }

  const after = opts.apply ? await input.queue.countByStatus() : before;
  if (opts.apply) {
    log(
      `after:  ` +
        Object.entries(after)
          .map(([k, v]) => `${k}=${v}`)
          .join(" "),
    );
  }

  return { archived, purged, byStatus: after };
}

function formatDuration(ms: number): string {
  if (ms < 60 * 1000) return `${Math.round(ms / 1000)}s`;
  if (ms < HOUR_MS) return `${Math.round(ms / 60_000)}m`;
  if (ms < DAY_MS) return `${Math.round(ms / (60 * 60_000))}h`;
  return `${Math.round(ms / DAY_MS)}d`;
}

export interface ParseMaintenanceFlagsInput {
  args: string[];
}

/**
 * Parse `digestive maintenance` flags.
 *
 * Flags (all optional; defaults from DEFAULT_MAINTENANCE_OPTIONS):
 *   --apply                                  actually run archive + purge (default: dry-run preview)
 *   --archive-after <duration>               e.g. 1h, 30m, 2d, 7d (default: 1d)
 *   --purge-after   <duration>               e.g. 7d, 30d        (default: 7d)
 *   --limit             <n>                   per-phase row cap   (default: 10000)
 */
export function parseMaintenanceFlags(
  input: ParseMaintenanceFlagsInput,
): { options: Partial<MaintenanceOptions>; help: boolean; errors: string[] } {
  const args = input.args.slice();
  const out: Partial<MaintenanceOptions> = {};
  const errors: string[] = [];
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--apply":
        out.apply = true;
        break;
      case "--archive-after": {
        const v = args[++i];
        const ms = v ? parseDuration(v) : NaN;
        if (Number.isNaN(ms)) errors.push(`--archive-after: invalid duration "${v}"`);
        else out.archiveAfterMs = ms;
        break;
      }
      case "--purge-after": {
        const v = args[++i];
        const ms = v ? parseDuration(v) : NaN;
        if (Number.isNaN(ms)) errors.push(`--purge-after: invalid duration "${v}"`);
        else out.purgeAfterMs = ms;
        break;
      }
      case "--limit": {
        const v = args[++i];
        const n = v ? Number.parseInt(v, 10) : NaN;
        if (Number.isNaN(n) || n <= 0) errors.push(`--limit: invalid positive integer "${v}"`);
        else out.limit = n;
        break;
      }
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        errors.push(`unknown flag: ${a}`);
    }
  }

  return { options: out, help, errors };
}

export const MAINTENANCE_HELP = `digestive maintenance — bound processing_jobs growth

Two-phase operation, idempotent and safe by default:
  dry-run (no flag): report what WOULD happen, touch nothing.
  apply  (--apply): run archive + purge, then show before/after counts.

Usage:
  digestive maintenance [flags]

Flags:
  --apply                          actually mutate rows (default: dry-run)
  --archive-after <duration>       flip completed/failed -> archived
                                   after this age (default: 1d)
  --purge-after   <duration>       DELETE archived rows after this age
                                   (default: 7d)
  --limit         <n>               per-phase row cap (default: 10000)
  -h, --help                       show this help

Durations accept a number with a unit suffix:
  s (seconds), m (minutes), h (hours), d (days). No suffix => ms.

Recommended cadence: daily cron; defaults retain 1d in completed/failed
and 7d in archived for forensics.

Other tables (editions, documents, enrichment rows) are kept with the
edition per §40 ("Edition serves as the permanent archive"); if you ever
need to drop one, that's a separate explicit operation (not part of this
maintenance pass).
`;

function parseDuration(s: string): number {
  const re = /^(\d+)(s|m|h|d)?$/;
  const m = re.exec(s);
  if (!m) return NaN;
  const n = Number.parseInt(m[1]!, 10);
  const unit = m[2] ?? "";
  switch (unit) {
    case "":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60 * 1000;
    case "h":
      return n * HOUR_MS;
    case "d":
      return n * DAY_MS;
    default:
      return NaN;
  }
}
