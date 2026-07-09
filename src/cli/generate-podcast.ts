import type {
  PodcastService,
  PodcastServiceResult,
} from "../digest/notebooklm/podcast-service.js";

export interface GeneratePodcastCommandDeps {
  service: PodcastService;
  editionDate?: string | Date;
  partitionKey?: string;
  wait?: boolean;
  log?: (msg: string) => void;
}

export interface GeneratePodcastCommandResult {
  exitCode: number;
  result?: PodcastServiceResult;
}

export function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function runGeneratePodcastCommand(
  deps: GeneratePodcastCommandDeps,
): Promise<GeneratePodcastCommandResult> {
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
      `Podcast for edition ${result.edition.id} (date=${editionDate}, partition=${result.partitionKey}): ` +
        `podcastId=${result.podcastId}, artifact=${result.artifactExternalId}, ` +
        `url=${result.url ?? "none"}, localPath=${result.localPath ?? "none"}, ` +
        `status=${result.status}, durationSeconds=${result.durationSeconds ?? "n/a"}, ` +
        `alreadyExisted=${result.alreadyExisted ? "true" : "false"}, ` +
        `mode=${deps.wait ? "wait" : "fire-and-forget"}`,
    );
    if (result.failureReason) {
      log(`note: ${result.failureReason}`);
    }
    const exitCode = result.status === "failed" ? 1 : 0;
    return { exitCode, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`generate-podcast failed: ${msg}`);
    return { exitCode: 1 };
  }
}

export interface ParseGeneratePodcastFlagsInput {
  args: string[];
}

export interface ParseGeneratePodcastFlagsResult {
  editionDate?: string;
  partitionKey?: string;
  wait: boolean;
  help: boolean;
  errors: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseGeneratePodcastFlags(
  input: ParseGeneratePodcastFlagsInput,
): ParseGeneratePodcastFlagsResult {
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

export const GENERATE_PODCAST_HELP = `digestive generate-podcast — kick off a NotebookLM audio podcast for the edition

Usage:
  digestive generate-podcast [--date <YYYY-MM-DD>] [--partition <key>] [--wait]

Flags:
  --date <YYYY-MM-DD>    publication date of the edition (default: today)
  --partition <key>      partition key within the edition (default: "master").
                         Must match the partition used to generate the
                         notebook; non-master partitions each have their
                         own notebook and their own podcast.
  --wait                  block until NotebookLM finishes generating the audio
                          (10-20 min typical). Default is fire-and-forget:
                          the call returns immediately and the row is left
                          in 'generating' with the artifact id. Re-run with
                          --wait later to fetch the URL and download the mp3.
  -h, --help             show this help

The command:
  1. resolves the Edition by publication date
  2. verifies a Markdown digest exists for the edition
  3. verifies a NotebookLM notebook exists for the requested partition
  4. starts a NotebookLM audio generation (fire-and-forget; the row is marked
     'generating' with the artifact id and a started_at timestamp)
  5. (only with --wait) polls until the artifact is complete, persists the URL,
     downloads the mp3 to NOTEBOOKLM_OUTPUT_DIR (default ./notebooks), and
     marks the row 'ready'
  6. re-running against an edition with a 'ready' row is a no-op
     (idempotency per §48). Re-running against a 'generating' row recovers the
     URL via waitForArtifact (still requires --wait to actually wait).

Without --wait the CLI exits 0 immediately and the operator checks on
status later via 'notebooklm artifact list -n <notebook>' or by re-running
the command with --wait.
`;
