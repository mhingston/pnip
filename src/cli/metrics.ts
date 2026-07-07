import type { Kysely } from "kysely";
import type { Database } from "../database/kysely.js";
import type {
  ProcessingJobQueue,
  QueueMetrics,
} from "../jobs/queue/processing-job-queue.js";
import {
  getEditionMetrics,
  type EditionMetrics,
} from "../editions/edition-metrics.js";

export interface MetricsCommandDeps {
  db: Kysely<Database>;
  queue: ProcessingJobQueue;
  log?: (msg: string) => void;
}

export interface MetricsCommandResult {
  exitCode: number;
  queue: QueueMetrics;
  editions: EditionMetrics;
}

export interface ParseMetricsFlagsInput {
  args: string[];
}

/**
 * Parse `digestive metrics` flags. The only supported flag is -h/--help;
 * any other token is reported as an error so typos don't silently pass.
 */
export function parseMetricsFlags(
  input: ParseMetricsFlagsInput,
): { help: boolean; errors: string[] } {
  const args = input.args.slice();
  const errors: string[] = [];
  let help = false;
  for (const a of args) {
    switch (a) {
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        errors.push(`unknown flag: ${a}`);
    }
  }
  return { help, errors };
}

/**
 * Read-only §58 metrics snapshot. Calls `queue.getMetrics()` and
 * `getEditionMetrics(db)`, logs a four-line summary, and exits 0.
 */
export async function runMetricsCommand(
  deps: MetricsCommandDeps,
): Promise<MetricsCommandResult> {
  const log = deps.log ?? ((m: string) => console.log(m));

  const queueMetrics = await deps.queue.getMetrics();
  const editionMetrics = await getEditionMetrics(deps.db);

  log(
    "queue: " +
      [
        `pending=${queueMetrics.byStatus.pending ?? 0}`,
        `running=${queueMetrics.byStatus.running ?? 0}`,
        `completed=${queueMetrics.byStatus.completed ?? 0}`,
        `failed=${queueMetrics.byStatus.failed ?? 0}`,
        `archived=${queueMetrics.byStatus.archived ?? 0}`,
      ].join(" "),
  );
  log(
    "queue: " +
      [
        `totalRetries=${queueMetrics.totalRetries}`,
        `maxRetries=${queueMetrics.maxRetries}`,
        `avgLatencyMs=${queueMetrics.avgProcessingLatencyMs ?? "null"}`,
        `throughputLastHour=${queueMetrics.throughputLastHour}`,
        `throughputLastDay=${queueMetrics.throughputLastDay}`,
        `oldestPendingAgeMs=${queueMetrics.oldestPendingAgeMs ?? "null"}`,
      ].join(" "),
  );
  log(
    "editions: " +
      [
        `total=${editionMetrics.total}`,
        `published=${editionMetrics.byStatus.published ?? 0}`,
        `building=${editionMetrics.byStatus.building ?? 0}`,
        `ready=${editionMetrics.byStatus.ready ?? 0}`,
        `publishing=${editionMetrics.byStatus.publishing ?? 0}`,
        `failed=${editionMetrics.byStatus.failed ?? 0}`,
      ].join(" "),
  );
  log(
    "editions: " +
      [
        `avgPublicationDurationMs=${editionMetrics.avgPublicationDurationMs ?? "null"}`,
        `lastPublishedAt=${editionMetrics.lastPublishedAt ? editionMetrics.lastPublishedAt.toISOString() : "null"}`,
        `oldestBuildingAgeMs=${editionMetrics.oldestBuildingAgeMs ?? "null"}`,
      ].join(" "),
  );

  return {
    exitCode: 0,
    queue: queueMetrics,
    editions: editionMetrics,
  };
}

export const METRICS_HELP = `digestive metrics — §58 internal metrics snapshot

Read-only snapshot of queue and edition health. Surfaces:
  - jobs completed/failed and retry counts (total + max)
  - avg processing latency for completed jobs (created_at -> completed_at)
  - throughput: completed jobs in the last hour / last day
  - oldest pending job age (ms since created_at)
  - edition status mix and total published count
  - avg publication duration (created_at -> published_at, ms)
  - last published edition timestamp
  - oldest building edition age (ms since created_at)

No rows are written. Safe to run against a live queue or an empty DB.

Usage:
  digestive metrics [flags]

Flags:
  -h, --help    show this help

Exit codes:
  0   metrics gathered and logged
`;
