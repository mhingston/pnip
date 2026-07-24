import type { EditionRolloverService } from "../editions/edition-rollover-service.js";

export interface RolloverUnenrichedCommandDeps {
  service: EditionRolloverService;
  resolveEditionId: (date: string) => Promise<string | undefined>;
  editionDate?: string | Date;
  log?: (msg: string) => void;
}

export interface RolloverUnenrichedCommandResult {
  exitCode: number;
  result?: Awaited<ReturnType<EditionRolloverService["rolloverUnreadyDocuments"]>>;
}

export function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function runRolloverUnenrichedCommand(
  deps: RolloverUnenrichedCommandDeps,
): Promise<RolloverUnenrichedCommandResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const editionDateRaw = deps.editionDate ?? todayDate();
  const editionDate =
    typeof editionDateRaw === "string" ? editionDateRaw : editionDateRaw.toISOString().slice(0, 10);

  const editionId = await deps.resolveEditionId(editionDate);
  if (!editionId) {
    log(`rollover-unenriched failed: no edition found for date ${editionDate}`);
    return { exitCode: 1 };
  }

  try {
    const result = await deps.service.rolloverUnreadyDocuments(editionId);
    log(
      `Rolled over unready documents: moved ${result.movedDocumentCount} documents, ` +
        `${result.movedJobCount} jobs, requeued ${result.requeuedJobCount ?? 0} jobs, ` +
        `${result.movedDiscoveryEventCount} discovery events; ` +
        `cancelled ${result.cancelledJobCount} jobs; ` +
        `deleted ${result.deletedStoryIds.length} empty stories. ` +
        `Source edition ${result.sourceEditionId} → target edition ${result.targetEditionId}.`,
    );
    return { exitCode: 0, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`rollover-unenriched failed: ${msg}`);
    return { exitCode: 1 };
  }
}

export interface ParseRolloverUnenrichedFlagsInput {
  args: string[];
}

export interface ParseRolloverUnenrichedFlagsResult {
  editionDate?: string;
  help: boolean;
  errors: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseRolloverUnenrichedFlags(
  input: ParseRolloverUnenrichedFlagsInput,
): ParseRolloverUnenrichedFlagsResult {
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

export const ROLLOVER_UNENRICHED_HELP = `digestive rollover-unenriched — roll unready documents to the next edition

Usage:
  digestive rollover-unenriched [--date <YYYY-MM-DD>]

Flags:
  --date <YYYY-MM-DD>    publication date of the edition to roll over (default: today)
  -h, --help             show this help

At the publish deadline, an edition may not be fully ready: some documents are
still being enriched, clustered, or waiting for their story summary. This
command moves every document that is not yet represented by a story that has a
story summary to the next open mutable edition, and re-targets in-flight
processing work so the next edition's drain can pick it up. The source edition
keeps only the publishable documents, so its readiness gate can succeed and the
daily publish can ship what is ready.

The command is a no-op when the source edition is not in a mutable state
(building/failed) or when every document is already ready. Calling it on an
edition in 'ready' or later is a no-op; calling it on an empty edition is a
no-op.
`;
