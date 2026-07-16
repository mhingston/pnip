import type { Kysely } from "kysely";
import {
  PublicationGateFailedError,
  PublicationStateError,
  type CompletionReport,
  type PublicationService,
  type PublicationServiceResult,
} from "../publication/publication-service.js";
import type { Database, Edition } from "../database/kysely.js";
import type { PartitionConfig } from "../config/index.js";
import { PARTITION_MASTER } from "../discovery/partition-resolver.js";

const DEFAULT_MIN_ARTICLES = 5;

export interface PartitionBreakdownEntry {
  partitionKey: string;
  documentCount: number;
  active: boolean;
  minArticles: number;
  enabled: boolean;
  notebookReady: boolean | null;
  podcastRequired: boolean | null;
  podcastReady: boolean | null;
}

export interface PublishEditionCommandDeps {
  service: PublicationService;
  editionLookup: {
    getByDate(editionDate: string | Date): Promise<Edition | undefined>;
  };
  db?: Kysely<Database>;
  partitionConfig?: PartitionConfig;
  editionDate?: string | Date;
  dryRun?: boolean;
  log?: (msg: string) => void;
}

export interface PublishEditionCommandResult {
  exitCode: number;
  result?: PublicationServiceResult;
  completion?: CompletionReport;
}

export function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function buildPartitionBreakdown(input: {
  db: Kysely<Database>;
  editionId: string;
  config: PartitionConfig;
  completion: CompletionReport;
}): Promise<PartitionBreakdownEntry[]> {
  const { db, editionId, config, completion } = input;
  const rows = await db
    .selectFrom("documents")
    .select((eb) => [
      "partition_key",
      eb.fn.count<number>("id").as("n"),
    ])
    .where("edition_id", "=", editionId)
    .groupBy("partition_key")
    .execute();
  const counts = new Map<string, number>();
  for (const r of rows) {
    counts.set(r.partition_key, Number(r.n));
  }
  const masterCount = Array.from(counts.values()).reduce(
    (total, count) => total + count,
    0,
  );

  const breakdown: PartitionBreakdownEntry[] = [
    {
      partitionKey: PARTITION_MASTER,
      documentCount: masterCount,
      active: true,
      minArticles: 0,
      enabled: true,
      notebookReady: completion.notebookReady,
      podcastRequired: true,
      podcastReady: completion.podcastReady,
    },
  ];

  for (const [partitionKey, entry] of Object.entries(config)) {
    if (entry.enabled === false) continue;
    const minArticles = entry.min_articles ?? DEFAULT_MIN_ARTICLES;
    const documentCount = counts.get(partitionKey) ?? 0;
    const active = documentCount >= minArticles;
    const partitionStatus = completion.partitionNotebooks.find(
      (p) => p.partitionKey === partitionKey,
    );
    breakdown.push({
      partitionKey,
      documentCount,
      active,
      minArticles,
      enabled: true,
      notebookReady: partitionStatus?.notebookReady ?? null,
      podcastRequired: partitionStatus?.podcastRequired ?? null,
      podcastReady: partitionStatus?.podcastReady ?? null,
    });
  }

  return breakdown;
}

function renderBreakdownLine(entry: PartitionBreakdownEntry): string {
  const docStr = `${entry.documentCount} docs`;
  if (entry.partitionKey === PARTITION_MASTER) {
    return `  master: ${docStr}, ` +
      `notebook=${entry.notebookReady ? "ready" : "pending"}, ` +
      `podcast=${entry.podcastReady ? "ready" : "pending"}`;
  }
  if (!entry.active) {
    return `  ${entry.partitionKey}: ${docStr}, ` +
      `skipped (below min_articles=${entry.minArticles})`;
  }
  const notebookState = entry.notebookReady ? "ready" : "pending";
  if (entry.podcastRequired) {
    const podcastState = entry.podcastReady ? "ready" : "pending";
    return `  ${entry.partitionKey}: ${docStr}, ` +
      `notebook=${notebookState}, podcast=${podcastState}`;
  }
  return `  ${entry.partitionKey}: ${docStr}, notebook=${notebookState}`;
}

export async function runPublishEditionCommand(
  deps: PublishEditionCommandDeps,
): Promise<PublishEditionCommandResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const editionDate = deps.editionDate ?? todayDate();

  if (deps.dryRun) {
    const edition = await deps.editionLookup.getByDate(editionDate);
    if (!edition) {
      log(
        `publish-edition --dry-run: no edition for date ${String(editionDate)}`,
      );
      return { exitCode: 1 };
    }

    if (
      edition.status !== "ready" &&
      edition.status !== "publishing" &&
      edition.status !== "published"
    ) {
      log(
        `publish-edition --dry-run blocked for edition ${edition.id} ` +
          `(date=${String(editionDate)}): status=${edition.status}; ` +
          "the readiness gate must transition building → ready before publication",
      );
      return { exitCode: 1 };
    }

    const report = await deps.service.checkCompletion(edition.id);

    log(
      `publish-edition --dry-run: partition breakdown for edition ${edition.id} ` +
        `(date=${String(editionDate)}):`,
    );
    if (deps.db) {
      const breakdown = await buildPartitionBreakdown({
        db: deps.db,
        editionId: edition.id,
        config: deps.partitionConfig ?? {},
        completion: report,
      });
      for (const entry of breakdown) {
        log(renderBreakdownLine(entry));
      }
    } else {
      log(`  master: notebook=${report.notebookReady ? "ready" : "pending"}, ` +
        `podcast=${report.podcastReady ? "ready" : "pending"}`);
    }

    // Podcasts are best-effort artifacts. The publication service deliberately
    // does not include them in missingArtifacts, so the read-only gate must
    // apply the same rule and never reject an otherwise complete edition.
    const allReady =
      report.markdownNonEmpty &&
      report.emailSent &&
      report.notebookReady &&
      report.partitionNotebooks.every((p) => p.notebookReady);

    if (allReady) {
      log(
        `publish-edition --dry-run OK for edition ${edition.id} ` +
          `(date=${String(editionDate)}): ` +
          `markdown=true, email=true, notebook=true, podcast=true`,
      );
      return { exitCode: 0, completion: report };
    }

    log(
      `publish-edition --dry-run: edition ${edition.id} ` +
        `(date=${String(editionDate)}) missing artifacts:`,
    );
    for (const m of report.missingArtifacts) {
      log(`  - ${m}`);
    }
    return { exitCode: 1, completion: report };
  }

  try {
    const result = await deps.service.publishForDate({ editionDate });
    log(
      `Edition ${result.edition.id} (date=${String(editionDate)}): ` +
        `status=${result.status}, ` +
        `cancelledJobCount=${result.cancelledJobCount}, ` +
        `alreadyExisted=${result.alreadyExisted ? "true" : "false"}`,
    );
    if (result.completion.missingArtifacts.length > 0) {
      log(
        `missing artifacts: ${result.completion.missingArtifacts.join(", ")}`,
      );
    }
    const exitCode =
      result.status === "published" ||
      result.status === "already_published" ||
      result.status === "publishing"
        ? 0
        : 1;
    return { exitCode, result, completion: result.completion };
  } catch (err) {
    if (err instanceof PublicationGateFailedError) {
      log(
        `publish-edition: gate failed for edition ${err.editionId} ` +
          `(date=${String(editionDate)}); missing artifacts:`,
      );
      for (const m of err.missingArtifacts) {
        log(`  - ${m}`);
      }
      return { exitCode: 1 };
    }
    if (err instanceof PublicationStateError) {
      log(`publish-edition blocked: ${err.message}`);
      return { exitCode: 1 };
    }
    const msg = err instanceof Error ? err.message : String(err);
    log(`publish-edition failed: ${msg}`);
    return { exitCode: 1 };
  }
}

export interface ParsePublishEditionFlagsInput {
  args: string[];
}

export interface ParsePublishEditionFlagsResult {
  editionDate?: string;
  dryRun: boolean;
  help: boolean;
  errors: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parsePublishEditionFlags(
  input: ParsePublishEditionFlagsInput,
): ParsePublishEditionFlagsResult {
  const args = input.args.slice();
  const errors: string[] = [];
  let editionDate: string | undefined;
  let dryRun = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--date": {
        const v = args[++i];
        if (!v || !DATE_RE.test(v)) {
          errors.push(`--date: invalid date "${v}", expected YYYY-MM-DD`);
        } else {
          editionDate = v;
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

  return { editionDate, dryRun, help, errors };
}

export const PUBLISH_EDITION_HELP = `digestive publish-edition — finalise an Edition: gate-check the required artifacts and transition Ready → Publishing → Published

Usage:
  digestive publish-edition [--date <YYYY-MM-DD>] [--dry-run]

Flags:
  --date <YYYY-MM-DD>    publication date of the edition (default: today)
  --dry-run              read-only gate check; does not mutate state. Exits 0
                         if the Markdown digest is non-empty, the email is
                         sent, and every required notebook is ready. Podcasts
                         are best-effort and never block publication; exits 1
                         and lists the missing artifacts otherwise.
  -h, --help             show this help

The command:
  1. resolves the Edition by publication date
  2. (with --dry-run) calls checkCompletion(editionId) only; logs a per-partition
     breakdown (master plus each configured partition) and the report
  3. (without --dry-run) calls publishForDate({ editionDate }):
       - verifies the completion gate (§49): markdown_digests row exists and
         is non-empty, email_digests row with delivery_status='sent' exists,
         notebooks row with status='ready' exists. Podcasts are optional.
         When PARTITION_CONFIG is set, every active non-master partition must
         also have a ready notebook. Gate failure
         throws PublicationGateFailedError and exits 1.
     - transitions Ready → Publishing → Published (Publishing → Failed is
       handled by InvalidEditionTransitionError from the repo).
     - cancels all pending and running processing_jobs for the edition
       (failure_reason = "cancelled by publication of edition <id>").
     - re-running against a Published edition returns already_published
       (idempotent no-op, exits 0). Re-running against a Publishing
       edition returns publishing (exits 0).
  4. logs a one-line summary: edition id, date, status,
     cancelledJobCount, alreadyExisted.
`;
