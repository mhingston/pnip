export interface ProcessFlagsInput {
  args: string[];
}

export interface ProcessFlagsResult {
  editionDate?: string;
  maxJobs?: number;
  help: boolean;
  errors: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseProcessFlags(
  input: ProcessFlagsInput,
): ProcessFlagsResult {
  const args = input.args.slice();
  const errors: string[] = [];
  let editionDate: string | undefined;
  let maxJobs: number | undefined;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case "--date": {
        const value = args[++i];
        if (!value || !DATE_RE.test(value)) {
          errors.push(`--date: invalid date "${value}", expected YYYY-MM-DD`);
        } else {
          editionDate = value;
        }
        break;
      }
      case "--max-jobs": {
        const value = args[++i];
        const parsed = value === undefined ? Number.NaN : Number(value);
        if (!value || !Number.isInteger(parsed) || parsed < 1) {
          errors.push(`--max-jobs: invalid value "${value}", expected a positive integer`);
        } else {
          maxJobs = parsed;
        }
        break;
      }
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        errors.push(`unknown flag: ${arg}`);
    }
  }

  return { editionDate, maxJobs, help, errors };
}

export const PROCESS_HELP = `digestive process — process queued jobs

Usage:
  digestive process [--date <YYYY-MM-DD>] [--max-jobs <N>]

Flags:
  --date <YYYY-MM-DD>    only claim jobs belonging to this edition
  --max-jobs <N>         stop after claiming at most N jobs
  -h, --help             show this help

Without flags, process drains every eligible job. The scheduler uses both
flags so a large backlog from an older edition cannot prevent the current
edition from being processed.
`;
