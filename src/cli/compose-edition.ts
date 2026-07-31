import type { EditorialCompositionResult } from "../editorial/editorial-plan-service.js";

export interface ComposeEditionCommandDeps {
  editionDate?: string | Date;
  compose: (editionId: string) => Promise<EditorialCompositionResult>;
  getEdition: (date: string | Date) => Promise<{ id: string; status: string } | undefined>;
  log?: (message: string) => void;
}

export interface ComposeEditionFlags { editionDate?: string; help: boolean; errors: string[]; }
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseComposeEditionFlags(input: { args: string[] }): ComposeEditionFlags {
  const errors: string[] = []; let editionDate: string | undefined; let help = false;
  for (let i = 0; i < input.args.length; i++) {
    const arg = input.args[i];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--date") { const value = input.args[++i]; if (!value || !DATE_RE.test(value)) errors.push(`--date: invalid date "${value}", expected YYYY-MM-DD`); else editionDate = value; }
    else errors.push(`unknown flag: ${arg}`);
  }
  return { editionDate, help, errors };
}

export const COMPOSE_EDITION_HELP = `digestive compose-edition — compose an edition from a frozen enriched corpus

Usage: digestive compose-edition [--date <YYYY-MM-DD>]
`;

export async function runComposeEditionCommand(deps: ComposeEditionCommandDeps): Promise<{ exitCode: number; result?: EditorialCompositionResult }> {
  const date = deps.editionDate ?? new Date().toISOString().slice(0, 10);
  const edition = await deps.getEdition(date);
  if (!edition) throw new Error(`no edition found for date ${String(date)}`);
  if (edition.status !== "building" && edition.status !== "failed") throw new Error(`edition ${edition.id} is immutable in status '${edition.status}'`);
  const result = await deps.compose(edition.id);
  (deps.log ?? console.log)(`edition ${edition.id}: documents=${result.documentCount}, stories=${result.storyCount}, inputHash=${result.inputHash}, status=${result.status}`);
  return { exitCode: 0, result };
}
