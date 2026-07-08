import type { Kysely } from "kysely";
import type { Database } from "../database/kysely.js";
import {
  type FeedbackSummary,
  type SignalRepository,
  type SourceIdentityStats,
} from "../signals/signal-repository.js";
import { createEditionRepository } from "../editions/edition-repository.js";
import { todayDate } from "./feedback.js";

export interface FeedbackSummaryCommandDeps {
  db: Kysely<Database>;
  signalRepo: SignalRepository;
  args: string[];
  log?: (msg: string) => void;
}

export interface FeedbackSummaryCommandResult {
  exitCode: number;
  summary?: FeedbackSummary;
  sourceStats?: SourceIdentityStats;
}

export interface ParsedFeedbackSummaryFlags {
  edition?: string;
  sourceIdentity?: string;
  limit: number;
  help: boolean;
  errors: string[];
}

export interface ParseFeedbackSummaryFlagsInput {
  args: string[];
}

export function parseFeedbackSummaryFlags(
  input: ParseFeedbackSummaryFlagsInput,
): ParsedFeedbackSummaryFlags {
  const args = input.args.slice();
  const errors: string[] = [];
  let help = false;
  let edition: string | undefined;
  let sourceIdentity: string | undefined;
  let limit = 10;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "-h":
      case "--help":
        help = true;
        break;
      case "--edition": {
        const v = args[++i];
        if (v === undefined) {
          errors.push("--edition requires a value");
        } else {
          edition = v;
        }
        break;
      }
      case "--source-identity": {
        const v = args[++i];
        if (v === undefined) {
          errors.push("--source-identity requires a value");
        } else {
          sourceIdentity = v;
        }
        break;
      }
      case "--limit": {
        const v = args[++i];
        if (v === undefined) {
          errors.push("--limit requires a value");
        } else {
          const n = Number.parseInt(v, 10);
          if (Number.isNaN(n) || n <= 0 || String(n) !== v.trim()) {
            errors.push(`--limit must be a positive integer, got "${v}"`);
          } else {
            limit = n;
          }
        }
        break;
      }
      default:
        if (a.startsWith("--")) {
          errors.push(`unknown flag: ${a}`);
        } else {
          errors.push(`unexpected positional arg: ${a}`);
        }
    }
  }

  return { edition, sourceIdentity, limit, help, errors };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatNetScore(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

export async function runFeedbackSummaryCommand(
  deps: FeedbackSummaryCommandDeps,
): Promise<FeedbackSummaryCommandResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const parsed = parseFeedbackSummaryFlags({ args: deps.args });

  if (parsed.help) {
    log(FEEDBACK_SUMMARY_HELP);
    return { exitCode: 0 };
  }

  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) log(e);
    log(FEEDBACK_SUMMARY_HELP);
    return { exitCode: 2 };
  }

  const date = parsed.edition ?? todayDate();
  const editionRepo = createEditionRepository(deps.db);
  let edition;
  try {
    edition = await editionRepo.getByDate(date);
  } catch (err) {
    log(`feedback-summary: edition lookup failed: ${errMsg(err)}`);
    return { exitCode: 1 };
  }
  if (!edition) {
    log(`feedback-summary: no edition for date ${date}`);
    return { exitCode: 1 };
  }

  if (parsed.sourceIdentity) {
    let stats: SourceIdentityStats;
    try {
      stats = await deps.signalRepo.getSourceIdentityStats(
        parsed.sourceIdentity,
      );
    } catch (err) {
      log(
        `feedback-summary: source-identity stats failed: ${errMsg(err)}`,
      );
      return { exitCode: 1 };
    }
    log(`source_identity: ${stats.source_identity}`);
    log(`  mute_count: ${stats.mute_count}`);
    log(`  chunk_star_count: ${stats.chunk_star_count}`);
    log(`  cited_in_story_count: ${stats.cited_in_story_count}`);
    log(`  total_signals: ${stats.total_signals}`);
    return { exitCode: 0, sourceStats: stats };
  }

  let summary: FeedbackSummary;
  try {
    summary = await deps.signalRepo.getFeedbackSummary({
      editionId: edition.id,
      limit: parsed.limit,
    });
  } catch (err) {
    log(`feedback-summary: aggregate failed: ${errMsg(err)}`);
    return { exitCode: 1 };
  }

  const dateStr = formatDate(edition.publication_date);

  log(`feedback summary for edition ${edition.id} (${dateStr}):`);
  log(
    `  total signals: ${summary.totalSignals} across ${summary.sourceIdentityCount} source identities, ${summary.storyVoteCount} stories with votes`,
  );

  const kindEntries = Object.entries(summary.signalCounts);
  if (kindEntries.length > 0) {
    const rendered = kindEntries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    log(`  by kind: ${rendered}`);
  }

  if (summary.topMutedSources.length > 0) {
    log(`  top muted sources:`);
    summary.topMutedSources.forEach((m, i) => {
      log(`    ${i + 1}. ${m.source_identity} (${m.mute_count} mutes)`);
    });
  }

  if (summary.topVotedStories.length > 0) {
    log(`  top voted stories:`);
    summary.topVotedStories.forEach((v, i) => {
      log(
        `    ${i + 1}. ${v.story_id} net=${formatNetScore(v.net_score)} (up=${v.up} down=${v.down})`,
      );
    });
  }

  if (summary.topStarredChunks.length > 0) {
    log(`  top starred chunks:`);
    summary.topStarredChunks.forEach((s, i) => {
      log(`    ${i + 1}. ${s.chunk_id} (${s.star_count} stars)`);
    });
  }

  return { exitCode: 0, summary };
}

export const FEEDBACK_SUMMARY_HELP = `digestive feedback-summary — read-only aggregate of feedback signals

Aggregates data from the signals table for a single edition. No rows are
written. Self-attributed, intended for the operator to inspect their own
feedback activity (see plan §65.3 Phase B).

Usage:
  digestive feedback-summary [flags]

Flags:
  --edition <YYYY-MM-DD>      edition date to summarize (default: today)
  --source-identity <key>      show per-source stats instead of aggregate
  --limit <n>                  top-N rows per section (default: 10)
  -h, --help                   show this help

By default logs a structured summary: total counts, per-kind counts, and
top-N muted sources, voted stories, and starred chunks for the edition.

With --source-identity, logs a 5-line per-source report instead:
  source_identity, mute_count, chunk_star_count, cited_in_story_count,
  total_signals.

Exit codes:
  0   summary rendered
  1   edition not found, no edition for date, or query failed
  2   invalid flags / unknown args
`;