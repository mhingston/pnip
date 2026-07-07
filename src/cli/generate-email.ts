import type {
  EmailDigestService,
  EmailDigestResult,
} from "../digest/html/email-digest-service.js";

export interface GenerateEmailCommandDeps {
  service: EmailDigestService;
  editionDate?: string | Date;
  dryRun?: boolean;
  log?: (msg: string) => void;
}

export interface GenerateEmailCommandResult {
  exitCode: number;
  result?: EmailDigestResult;
  preview?: {
    subject: string;
    htmlLength: number;
    textLength: number;
  };
}

export function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function runGenerateEmailCommand(
  deps: GenerateEmailCommandDeps,
): Promise<GenerateEmailCommandResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const editionDate = deps.editionDate ?? todayDate();

  try {
    if (deps.dryRun) {
      const preview = await deps.service.previewForDate({ editionDate });
      log(
        `Preview for edition ${preview.edition.id} (date=${editionDate}): ` +
          `subject="${preview.subject}", html=${preview.html.length}B, ` +
          `text=${preview.text.length}B`,
      );
      return {
        exitCode: 0,
        preview: {
          subject: preview.subject,
          htmlLength: preview.html.length,
          textLength: preview.text.length,
        },
      };
    }

    const result = await deps.service.sendForDate({ editionDate });
    log(
      `Email digest for edition ${result.edition.id} (date=${editionDate}): ` +
        `status=${result.deliveryStatus}, subject="${result.subject}", ` +
        `attempts=${result.attemptCount}, providerMessageId=${result.providerMessageId ?? "none"}, ` +
        `${result.alreadyExisted ? "alreadyExisted=true" : "created"}, ` +
        `${result.attempted ? "attemptedNow" : "noNewAttempt"}`,
    );
    if (result.failureReason) {
      log(`delivery failure reason: ${result.failureReason}`);
    }
    return {
      exitCode: result.deliveryStatus === "sent" ? 0 : 1,
      result,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`generate-email failed: ${msg}`);
    return { exitCode: 1 };
  }
}

export interface ParseGenerateEmailFlagsInput {
  args: string[];
}

export interface ParseGenerateEmailFlagsResult {
  editionDate?: string;
  dryRun: boolean;
  help: boolean;
  errors: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseGenerateEmailFlags(
  input: ParseGenerateEmailFlagsInput,
): ParseGenerateEmailFlagsResult {
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

export const GENERATE_EMAIL_HELP = `digestive generate-email — render and send the HTML email digest

Usage:
  digestive generate-email [--date <YYYY-MM-DD>] [--dry-run]

Flags:
  --date <YYYY-MM-DD>    publication date of the edition (default: today)
  --dry-run              render and report subject + sizes, but do NOT send
  -h, --help             show this help

The command:
  1. resolves the Edition by publication date
  2. loads the per-edition Markdown digest (must exist; run
     'digestive generate-digest' first)
  3. renders to HTML and plain text
  4. sends through Resend
  5. persists a per-edition email_digests row with the provider response

Resending an already-sent edition is a no-op (idempotency per §53).
`;
