import type { ProcessingJobQueue } from "../jobs/queue/processing-job-queue.js";
import type { Kysely } from "kysely";
import type { Database } from "../database/kysely.js";
import type { NotebookLmClient } from "../digest/notebooklm/notebooklm-client.js";
import {
  previewRetention,
  purgeExpiredData,
  type RetentionCounts,
} from "../retention/retention-service.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface MaintenanceOptions {
  archiveAfterMs: number;
  purgeAfterMs: number;
  retentionAfterMs: number;
  limit: number;
  apply: boolean;
}

export const DEFAULT_MAINTENANCE_OPTIONS: MaintenanceOptions = {
  archiveAfterMs: 24 * HOUR_MS,
  purgeAfterMs: 30 * DAY_MS,
  retentionAfterMs: 30 * DAY_MS,
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
  retention: RetentionCounts;
  notebooks: { candidates: number; deleted: number };
}

export type Log = (msg: string) => void;

const silent: Log = () => {};

export interface RunMaintenanceInput {
  queue: ProcessingJobQueue;
  db?: Kysely<Database>;
  notebookLm?: NotebookLmClient;
  options: Partial<MaintenanceOptions>;
  log?: Log;
}

/**
 * Maintenance helper for the processing-jobs queue.
 *
 * Two-phase operation:
 *   1. preview (default; apply=false): report what WOULD happen without writing.
 *   2. apply  (apply=true):            run queue cleanup and retention purge.
 *
 * The preview phase runs countByStatus() + a dry-run archive/purge estimate via
 * the same age filters, so the operator sees the headline numbers before any rows
 * are touched. The apply phase is idempotent (running it twice a day is fine).
 *
 * Defaults (overridable via options):
 *   - archiveAfterMs: 24h   - flip completed/failed jobs to status=archived
 *   - purgeAfterMs:   30d   - DELETE archived jobs older than this
 *   - retentionAfterMs: 30d - delete edition-linked data after this age
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

  let retention: RetentionCounts = { editions: 0, jobs: 0, lineage: 0 };
  const notebooks = { candidates: 0, deleted: 0 };
  if (input.db) {
    const notebookCutoff = new Date(Date.now() - opts.retentionAfterMs);
    const notebookCandidates = await input.db
      .selectFrom("notebooks")
      .innerJoin("editions", "editions.id", "notebooks.edition_id")
      .select([
        "notebooks.notebook_external_id as externalId",
        "editions.created_at as editionCreatedAt",
      ])
      .where("editions.created_at", "<", notebookCutoff)
      .orderBy("editions.created_at", "asc")
      .limit(opts.limit)
      .execute();
    notebooks.candidates = notebookCandidates.length;

    if (input.notebookLm && notebookCandidates.length > 0) {
      if (!input.notebookLm.deleteNotebook) {
        throw new Error("NotebookLM client does not support notebook deletion");
      }
      if (opts.apply) {
        // Delete provider resources before the database cascade removes their
        // local rows. Failed runs retain local references for a safe retry.
        for (const candidate of notebookCandidates) {
          await input.notebookLm.deleteNotebook(candidate.externalId);
          notebooks.deleted++;
        }
      }
    }

    retention = opts.apply
      ? await purgeExpiredData(input.db, {
          olderThanMs: opts.retentionAfterMs,
          limit: opts.limit,
        })
      : await previewRetention(input.db, {
          olderThanMs: opts.retentionAfterMs,
          limit: opts.limit,
        });
    if (opts.apply) {
      log(
        `retention: deleted ${retention.editions} edition(s), ` +
          `${retention.jobs} job(s), ${retention.lineage} lineage edge(s) ` +
          `older than ${formatDuration(opts.retentionAfterMs)}`,
      );
    } else {
      log(
        `dry-run: retention would delete ${retention.editions} edition(s), ` +
          `${retention.jobs} job(s), ${retention.lineage} lineage edge(s) ` +
          `older than ${formatDuration(opts.retentionAfterMs)}`,
      );
    }
    if (input.notebookLm) {
      log(
        opts.apply
          ? `notebooklm: deleted ${notebooks.deleted} notebook(s) older than ${formatDuration(opts.retentionAfterMs)}`
          : `dry-run: notebooklm would delete ${notebooks.candidates} notebook(s) older than ${formatDuration(opts.retentionAfterMs)}`,
      );
    }
  }

  return { archived, purged, byStatus: after, retention, notebooks };
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
 *   --purge-after   <duration>               e.g. 7d, 30d        (default: 30d)
 *   --retention-after <duration>             edition/data retention (default: 30d)
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
      case "--retention-after": {
        const v = args[++i];
        const ms = v ? parseDuration(v) : NaN;
        if (Number.isNaN(ms) || ms <= 0) errors.push(`--retention-after: invalid duration (must be positive) "${v}"`);
        else out.retentionAfterMs = ms;
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
                                   (default: 30d)
  --retention-after <duration>     DELETE edition-linked data after this age
                                   (default: 30d)
  --limit         <n>               per-phase row cap (default: 10000)
  -h, --help                       show this help

Durations accept a number with a unit suffix:
  s (seconds), m (minutes), h (hours), d (days). No suffix => ms.

Recommended cadence: run with --apply from cron every few hours. Edition-linked
source data, embeddings, enrichment rows, artifacts, discovery events, lineage,
old jobs, and their NotebookLM notebooks are deleted after 30 days by default
when NotebookLM is configured.
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
