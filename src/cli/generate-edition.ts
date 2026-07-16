import type { Edition } from "../database/kysely.js";
import type { EditionRepository } from "../editions/edition-repository.js";
import type { EditionReadinessGate } from "../editions/edition-readiness-gate.js";

export interface GenerateEditionCommandDeps {
  editionRepo: EditionRepository;
  readinessGate: EditionReadinessGate;
  editionDate?: string | Date;
  log?: (msg: string) => void;
}

export interface GenerateEditionCommandResult {
  exitCode: number;
  editionId?: string;
  transitioned?: boolean;
  status?: string;
}

export function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function runGenerateEditionCommand(
  deps: GenerateEditionCommandDeps,
): Promise<GenerateEditionCommandResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const editionDate = deps.editionDate ?? todayDate();

  const edition = await deps.editionRepo.getByDate(editionDate);
  if (!edition) {
    throw new Error(`no edition found for date ${String(editionDate)}`);
  }

  const result = await deps.readinessGate.transitionToReadyIfReady(edition.id);
  const updated: Edition = result.edition;
  log(
    `edition ${updated.id}: status=${updated.status}, transitioned=${result.transitioned ? "true" : "false"}`,
  );

  const exitCode =
    updated.status === "building" ||
    updated.status === "ready" ||
    updated.status === "publishing" ||
    updated.status === "published"
      ? 0
      : 1;
  return { exitCode, editionId: updated.id, transitioned: result.transitioned, status: updated.status };
}

export interface ParseGenerateEditionFlagsInput {
  args: string[];
}

export interface ParseGenerateEditionFlagsResult {
  editionDate?: string;
  help: boolean;
  errors: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseGenerateEditionFlags(
  input: ParseGenerateEditionFlagsInput,
): ParseGenerateEditionFlagsResult {
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

export const GENERATE_EDITION_HELP = `digestive generate-edition — evaluate the readiness gate for an edition

Resolves the edition by publication date (default: today) and runs the
readiness gate (transitionToReadyIfReady). If the edition is in 'building'
status and all the readiness checks pass, the gate transitions it to
'ready'; otherwise it stays in its current status and the gate returns
transitioned=false.

Usage:
  digestive generate-edition [--date <YYYY-MM-DD>]

Flags:
  --date <YYYY-MM-DD>    publication date of the edition (default: today)
  -h, --help             show this help

Exit codes:
  0   edition is in 'building', 'ready', 'publishing', or 'published' status
  1   readiness gate transitioned the edition to 'failed', or another error

This is a small helper to inspect / advance the building → ready transition
in isolation, separate from the daily pipeline that drains the queue.
`;
