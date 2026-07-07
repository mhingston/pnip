import type { ProcessingJob } from "../database/kysely.js";
import type { ProcessingJobQueue } from "../jobs/queue/processing-job-queue.js";

export interface RetryFilters {
  editionId?: string;
  jobType?: string;
  olderThanMs?: number;
  limit: number;
}

export interface RetryCommandDeps {
  queue: ProcessingJobQueue;
  filters?: Partial<RetryFilters>;
  dryRun?: boolean;
  log?: (msg: string) => void;
}

export interface RetryCommandResult {
  exitCode: number;
  listed?: number;
  requeued?: number;
}

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10_000;

function errMsg(msg: unknown): string {
  return msg instanceof Error ? msg.message : String(msg);
}

function summarizeLastError(job: ProcessingJob): string {
  const e = job.last_error as { message?: unknown } | null | undefined;
  if (!e || typeof e !== "object") return "(no error)";
  const m = e.message;
  if (typeof m === "string") return m;
  return JSON.stringify(e).slice(0, 200);
}

export async function runRetryCommand(
  deps: RetryCommandDeps,
): Promise<RetryCommandResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const limit = Math.min(deps.filters?.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const filters: Partial<RetryFilters> = { ...deps.filters, limit };
  const dryRun = deps.dryRun ?? false;

  let rows: ProcessingJob[];
  try {
    rows = await deps.queue.listFailed(filters);
  } catch (err) {
    log(`retry: listFailed failed: ${errMsg(err)}`);
    return { exitCode: 1 };
  }

  log(`retry: found ${rows.length} failed job(s)`);
  for (const j of rows.slice(0, 10)) {
    log(
      `  - ${j.id}  ${j.job_type}  ` +
        `edition=${j.edition_id ?? "-"}  ` +
        `error=${summarizeLastError(j)}`,
    );
  }
  if (rows.length > 10) {
    log(`  ... and ${rows.length - 10} more`);
  }

  if (dryRun) {
    log(`retry: dry-run; would requeue ${rows.length} job(s)`);
    return { exitCode: 0, listed: rows.length };
  }

  let requeued: number;
  try {
    requeued = await deps.queue.requeue(rows.map((r) => r.id));
  } catch (err) {
    log(`retry: requeue failed: ${errMsg(err)}`);
    return { exitCode: 1, listed: rows.length };
  }
  log(`retry: requeued ${requeued} job(s)`);
  return { exitCode: 0, listed: rows.length, requeued };
}

export interface ParseRetryFlagsInput {
  args: string[];
}

export interface ParseRetryFlagsResult {
  filters: Partial<RetryFilters>;
  dryRun: boolean;
  help: boolean;
  errors: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DURATION_RE = /^(\d+)(s|m|h|d)?$/;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function parseDurationMs(s: string): number {
  const m = DURATION_RE.exec(s);
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

export function parseRetryFlags(
  input: ParseRetryFlagsInput,
): ParseRetryFlagsResult {
  const args = input.args.slice();
  const filters: Partial<RetryFilters> = {};
  const errors: string[] = [];
  let dryRun = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--edition-id": {
        const v = args[++i];
        if (!v || !UUID_RE.test(v)) {
          errors.push(`--edition-id: invalid UUID "${v}"`);
        } else {
          filters.editionId = v;
        }
        break;
      }
      case "--worker":
      case "--job-type": {
        const v = args[++i];
        if (!v || v.length === 0) {
          errors.push(`${a}: missing job type`);
        } else {
          filters.jobType = v;
        }
        break;
      }
      case "--older-than": {
        const v = args[++i];
        const ms = v ? parseDurationMs(v) : NaN;
        if (Number.isNaN(ms)) {
          errors.push(`--older-than: invalid duration "${v}"`);
        } else {
          filters.olderThanMs = ms;
        }
        break;
      }
      case "--limit": {
        const v = args[++i];
        const n = v ? Number.parseInt(v, 10) : NaN;
        if (Number.isNaN(n) || n <= 0) {
          errors.push(`--limit: invalid positive integer "${v}"`);
        } else {
          filters.limit = Math.min(n, MAX_LIMIT);
        }
        break;
      }
      case "--dry-run":
        dryRun = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        errors.push(`unknown flag: ${a}`);
    }
  }

  return { filters, dryRun, help, errors };
}

export const RETRY_HELP = `digestive retry — requeue failed processing_jobs

Lists jobs with status='failed' (optionally filtered) and requeues them so
they become claimable again. Without --dry-run the rows are reset to
status='pending', retry_count=0, last_error=NULL, with cleared lock state;
with --dry-run only the list is printed.

Usage:
  digestive retry [flags]

Flags:
  --edition-id <uuid>         filter to one edition's failed jobs
  --worker <jobType>          filter by job_type (alias: --job-type)
  --job-type <jobType>        alias for --worker
  --older-than <duration>     only jobs whose updated_at is older than this
                              (suffixes: s, m, h, d; bare number = ms)
  --limit <n>                 max rows to list/requeue (default: 1000, max: 10000)
  --dry-run                   list only; do not requeue
  -h, --help                  show this help

Exit codes:
  0   listing OK; requeue completed (may be 0 rows)
  1   list/requeue error or invalid flags

Recommended cadence: after investigating the root cause of a wave of
failures. Use --dry-run first to see what would be requeued.
`;