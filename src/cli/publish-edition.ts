import {
  PublicationGateFailedError,
  type CompletionReport,
  type PublicationService,
  type PublicationServiceResult,
} from "../publication/publication-service.js";
import type { Edition } from "../database/kysely.js";

export interface PublishEditionCommandDeps {
  service: PublicationService;
  editionLookup: {
    getByDate(editionDate: string | Date): Promise<Edition | undefined>;
  };
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

    const report = await deps.service.checkCompletion(edition.id);
    const allReady =
      report.markdownNonEmpty &&
      report.emailSent &&
      report.notebookReady &&
      report.podcastReady;

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

export const PUBLISH_EDITION_HELP = `digestive publish-edition — finalise an Edition: gate-check the four artifacts and transition Ready → Publishing → Published

Usage:
  digestive publish-edition [--date <YYYY-MM-DD>] [--dry-run]

Flags:
  --date <YYYY-MM-DD>    publication date of the edition (default: today)
  --dry-run              read-only gate check; does not mutate state. Exits 0
                         if all four artifacts are ready (markdown digest
                         exists & non-empty, email sent, notebook ready,
                         podcast ready with a URL); exits 1 and lists the
                         missing artifacts otherwise.
  -h, --help             show this help

The command:
  1. resolves the Edition by publication date
  2. (with --dry-run) calls checkCompletion(editionId) only; logs the report
  3. (without --dry-run) calls publishForDate({ editionDate }):
     - verifies the completion gate (§49): markdown_digests row exists and
       is non-empty, email_digests row with delivery_status='sent' exists,
       notebooks row with status='ready' exists, podcasts row with
       status='ready' and a non-null URL exists. Gate failure throws
       PublicationGateFailedError and exits 1.
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