import type {
  NotebookService,
  NotebookServiceResult,
} from "../digest/notebooklm/notebook-service.js";

export interface GenerateNotebookCommandDeps {
  service: NotebookService;
  editionDate?: string | Date;
  partitionKey?: string;
  wait?: boolean;
  log?: (msg: string) => void;
}

export interface GenerateNotebookCommandResult {
  exitCode: number;
  result?: NotebookServiceResult;
}

export function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function runGenerateNotebookCommand(
  deps: GenerateNotebookCommandDeps,
): Promise<GenerateNotebookCommandResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const editionDate = deps.editionDate ?? todayDate();
  const partitionKey = deps.partitionKey ?? "master";

  try {
    const result = await deps.service.generateForDate({
      editionDate,
      partitionKey,
      wait: deps.wait,
    });
    log(
      `Notebook for edition ${result.edition.id} (date=${editionDate}, partition=${result.partitionKey}): ` +
        `notebookId=${result.notebookId || "(skipped)"}, url=${result.url}, ` +
        `sources=${result.sourceCount}, status=${result.status}, ` +
        `${result.alreadyExisted ? "alreadyExisted=true" : "created"}, ` +
        `mode=${result.mode}`,
    );
    if (result.skipReason) {
      log(`skip reason: ${result.skipReason}`);
    }
    if (result.failureReason) {
      log(`failure reason: ${result.failureReason}`);
    }
    const exitCode = result.status === "failed" ? 1 : 0;
    return { exitCode, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`generate-notebook failed: ${msg}`);
    return { exitCode: 1 };
  }
}

export interface ParseGenerateNotebookFlagsInput {
  args: string[];
}

export interface ParseGenerateNotebookFlagsResult {
  editionDate?: string;
  partitionKey?: string;
  wait: boolean;
  help: boolean;
  errors: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseGenerateNotebookFlags(
  input: ParseGenerateNotebookFlagsInput,
): ParseGenerateNotebookFlagsResult {
  const args = input.args.slice();
  const errors: string[] = [];
  let editionDate: string | undefined;
  let partitionKey: string | undefined;
  let wait = false;
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
      case "--partition": {
        const v = args[++i];
        if (!v || v.length === 0) {
          errors.push(`--partition: missing value`);
        } else {
          partitionKey = v;
        }
        break;
      }
      case "--wait":
        wait = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        errors.push(`unknown flag: ${a}`);
    }
  }

  return { editionDate, partitionKey, wait, help, errors };
}

export const GENERATE_NOTEBOOK_HELP = `digestive generate-notebook — create a NotebookLM notebook for the edition

Usage:
  digestive generate-notebook [--date <YYYY-MM-DD>] [--partition <key>] [--wait]

Flags:
  --date <YYYY-MM-DD>    publication date of the edition (default: today)
  --partition <key>      partition key within the edition (default: "master").
                         Other values come from the partition config (e.g.
                         "youtube", "reddit", "blogs"). The master partition
                         sees every document; each non-master partition
                         sees only documents whose partition_key matches.
  --wait                  block until every source has finished ingesting
                          (1-10 min per source typical). Default is
                          fire-and-forget: the call returns immediately
                          after the upload step and the row is left in
                          'pending' with the source ids. Re-run with
                          --wait later to poll until ready.
  -h, --help             show this help

The command:
  1. resolves the Edition by publication date
  2. loads the curated source documents for the requested partition and
     the per-edition Markdown digest
  3. if the partition has fewer than the configured min_articles documents,
     returns a "skipped" result without calling NotebookLM (the master
     partition is unaffected)
  4. creates a NotebookLM notebook titled "Daily Digest — <date>"
     (or the result of config.titleTemplate when configured)
  5. uploads each source document as a URL/file source, then uploads the
     Markdown digest as a final markdown source so NotebookLM can ground
     answers in both the curated sources and the digest narrative
  6. (only with --wait) polls waitForSource for each source in turn;
     on success marks the notebook row 'ready', on error marks it 'failed'
     with the offending source id. Re-running with --wait against a
     'pending' row resumes the polling for the previously uploaded sources.

Without --wait the CLI exits 0 immediately and the operator can poll
later via 'notebooklm source list -n <notebook>' or by re-running the
command with --wait. The podcast step (generate-podcast) accepts any
notebook row regardless of status, so the operator can kick off the
audio generation as soon as the notebook exists.
`;
