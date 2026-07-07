import type {
  MarkdownDigestService,
  MarkdownDigestResult,
} from "../digest/markdown/markdown-digest-service.js";

export interface GenerateDigestCommandDeps {
  service: MarkdownDigestService;
  editionDate?: string | Date;
  log?: (msg: string) => void;
}

export interface GenerateDigestCommandResult {
  exitCode: number;
  result?: MarkdownDigestResult;
}

export function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function runGenerateDigestCommand(
  deps: GenerateDigestCommandDeps,
): Promise<GenerateDigestCommandResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const editionDate = deps.editionDate ?? todayDate();

  try {
    const result = await deps.service.generateForDate({ editionDate });
    log(
      `Generated markdown digest for edition ${result.edition.id} (date=${editionDate}, ` +
        `digestId=${result.digestId}, stories=${result.storyCount}, ` +
        `sources=${result.documentCount}, citations=${result.citationCount}, ` +
        `${result.alreadyExisted ? "alreadyExisted=true" : "created"})`,
    );
    return { exitCode: 0, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`generate-digest failed: ${msg}`);
    return { exitCode: 1 };
  }
}

export interface ParseGenerateDigestFlagsInput {
  args: string[];
}

export interface ParseGenerateDigestFlagsResult {
  editionDate?: string;
  help: boolean;
  errors: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseGenerateDigestFlags(
  input: ParseGenerateDigestFlagsInput,
): ParseGenerateDigestFlagsResult {
  const args = input.args.slice();
  const errors: string[] = [];
  let editionDate: string | undefined;
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
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        errors.push(`unknown flag: ${a}`);
    }
  }

  return { editionDate, help, errors };
}

export const GENERATE_DIGEST_HELP = `digestive generate-digest — render a deterministic Markdown digest

Usage:
  digestive generate-digest [--date <YYYY-MM-DD>]

Flags:
  --date <YYYY-MM-DD>    publication date of the edition to render (default: today)
  -h, --help             show this help

The command renders the Markdown digest for the given edition using the
existing story summaries and source metadata. It is deterministic — running
it twice against the same edition produces byte-identical Markdown.

If a digest already exists for the edition, the command is a no-op and
returns exit code 0 (idempotency per §53).
`;
