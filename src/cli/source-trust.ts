import type { SourceTrustRepository, SourceTrustRow } from "../signals/source-trust-repository.js";

export interface SourceTrustCommandDeps {
  repo: SourceTrustRepository;
  args: string[];
  log?: (msg: string) => void;
}

export interface SourceTrustCommandResult {
  exitCode: number;
}

export const SOURCE_TRUST_HELP = `digestive source-trust — manage per-source trust tiers

Source trust tiers (1-5) bias cluster re-ranking: clusters built from
higher-trust (lower tier number) sources sort earlier in the digest.
1 = editor's core sources, 3 = default (unrated), 5 = lowest trust.

Usage:
  digestive source-trust <subcommand> [options]

Subcommands:
  set <source_identity> <tier> [--notes "..."]   upsert a trust tier (1-5)
  get <source_identity>                           print the tier for a source
  list                                            print all source_trust rows
  delete <source_identity>                        remove a row
  -h, --help                                      show this help

The <source_identity> is the normalized key produced by
deriveSourceIdentity() (e.g. theverge.com, reddit.com/r/machinelearning,
youtube.com/channel:UC...).

Exit codes: 0 success, 1 runtime error, 2 parse/usage error.
`;

const silent: (msg: string) => void = () => {};

function isIntegerTier(s: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(s);
}

function formatRow(row: SourceTrustRow): string {
  const notes = row.notes ? `  notes=${row.notes}` : "";
  return `${row.source_identity}\t${row.tier}${notes}`;
}

export async function runSourceTrustCommand(
  deps: SourceTrustCommandDeps,
): Promise<SourceTrustCommandResult> {
  const log = deps.log ?? silent;
  const args = deps.args.slice();

  if (args.length === 0) {
    log(SOURCE_TRUST_HELP);
    return { exitCode: 2 };
  }

  const sub = args[0]!;

  if (sub === "-h" || sub === "--help") {
    log(SOURCE_TRUST_HELP);
    return { exitCode: 0 };
  }

  if (sub === "set") {
    const positional: string[] = [];
    let notes: string | undefined;
    for (let i = 1; i < args.length; i++) {
      const a = args[i]!;
      if (a === "--notes") {
        const v = args[++i];
        if (v === undefined) {
          log("source-trust set: --notes requires a value");
          log(SOURCE_TRUST_HELP);
          return { exitCode: 2 };
        }
        notes = v;
      } else if (a === "-h" || a === "--help") {
        log(SOURCE_TRUST_HELP);
        return { exitCode: 0 };
      } else {
        positional.push(a);
      }
    }

    if (positional.length !== 2) {
      log("source-trust set: expected <source_identity> <tier>");
      log(SOURCE_TRUST_HELP);
      return { exitCode: 2 };
    }
    const [sourceIdentity, tierStr] = positional as [string, string];
    if (!isIntegerTier(tierStr)) {
      log(`source-trust set: tier must be an integer 1-5, got "${tierStr}"`);
      return { exitCode: 2 };
    }
    const tier = Number.parseInt(tierStr, 10);
    if (tier < 1 || tier > 5) {
      log(`source-trust set: tier must be between 1 and 5, got ${tier}`);
      return { exitCode: 2 };
    }

    try {
      const row = await deps.repo.set(sourceIdentity, tier, notes ?? null);
      log(`set ${row.source_identity} tier=${row.tier}${row.notes ? ` notes=${row.notes}` : ""}`);
      return { exitCode: 0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`source-trust set failed: ${msg}`);
      return { exitCode: 1 };
    }
  }

  if (sub === "get") {
    const rest = args.slice(1);
    if (rest.length === 0 || rest.includes("-h") || rest.includes("--help")) {
      if (rest.length === 0) {
        log("source-trust get: expected <source_identity>");
        log(SOURCE_TRUST_HELP);
        return { exitCode: 2 };
      }
      log(SOURCE_TRUST_HELP);
      return { exitCode: 0 };
    }
    if (rest.length !== 1) {
      log("source-trust get: expected exactly one <source_identity>");
      log(SOURCE_TRUST_HELP);
      return { exitCode: 2 };
    }
    const sourceIdentity = rest[0]!;
    try {
      const row = await deps.repo.get(sourceIdentity);
      if (!row) {
        log(`no source_trust row for ${sourceIdentity}`);
        return { exitCode: 1 };
      }
      log(formatRow(row));
      return { exitCode: 0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`source-trust get failed: ${msg}`);
      return { exitCode: 1 };
    }
  }

  if (sub === "list") {
    const rest = args.slice(1);
    if (rest.includes("-h") || rest.includes("--help")) {
      log(SOURCE_TRUST_HELP);
      return { exitCode: 0 };
    }
    try {
      const rows = await deps.repo.getAll();
      if (rows.length === 0) {
        log("(no source_trust rows)");
      } else {
        for (const row of rows) log(formatRow(row));
      }
      return { exitCode: 0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`source-trust list failed: ${msg}`);
      return { exitCode: 1 };
    }
  }

  if (sub === "delete") {
    const rest = args.slice(1);
    if (rest.length === 0 || rest.includes("-h") || rest.includes("--help")) {
      if (rest.length === 0) {
        log("source-trust delete: expected <source_identity>");
        log(SOURCE_TRUST_HELP);
        return { exitCode: 2 };
      }
      log(SOURCE_TRUST_HELP);
      return { exitCode: 0 };
    }
    if (rest.length !== 1) {
      log("source-trust delete: expected exactly one <source_identity>");
      log(SOURCE_TRUST_HELP);
      return { exitCode: 2 };
    }
    const sourceIdentity = rest[0]!;
    try {
      const existing = await deps.repo.get(sourceIdentity);
      if (!existing) {
        log(`no source_trust row for ${sourceIdentity}`);
        return { exitCode: 1 };
      }
      await deps.repo.delete(sourceIdentity);
      log(`deleted ${sourceIdentity}`);
      return { exitCode: 0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`source-trust delete failed: ${msg}`);
      return { exitCode: 1 };
    }
  }

  log(`source-trust: unknown subcommand "${sub}"`);
  log(SOURCE_TRUST_HELP);
  return { exitCode: 2 };
}
