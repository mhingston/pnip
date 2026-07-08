import type { SignalRepository } from "../signals/signal-repository.js";
import type { EditionRepository } from "../editions/edition-repository.js";
import type { StoryRepository } from "../clustering/story-repository.js";
import type { DocumentRepository } from "../expansion/document-repository.js";
import type { ChunkRepository } from "../chunking/chunk-repository.js";
import { deriveSourceIdentity } from "../signals/source-identity.js";

export interface FeedbackDeps {
  signalRepo: SignalRepository;
  editionRepo: EditionRepository;
  storyRepo: StoryRepository;
  docRepo: DocumentRepository;
  chunkRepo: ChunkRepository;
  log?: (msg: string) => void;
}

export interface FeedbackCommandDeps extends FeedbackDeps {
  args: string[];
}

export interface FeedbackCommandResult {
  exitCode: number;
  signalId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export type FeedbackSubcommand = "rate" | "hide" | "star";

export interface FeedbackRateFlags {
  editionId: string;
  storyId: string;
  direction: "up" | "down";
}

export interface FeedbackHideFlags {
  sourceUrl: string;
}

export interface FeedbackStarFlags {
  chunkId: string;
}

export interface ParsedFeedbackFlags {
  subcommand?: FeedbackSubcommand;
  rate?: FeedbackRateFlags;
  hide?: FeedbackHideFlags;
  star?: FeedbackStarFlags;
  help: boolean;
  errors: string[];
}

export interface ParseFeedbackFlagsInput {
  args: string[];
}

export function parseFeedbackFlags(
  input: ParseFeedbackFlagsInput,
): ParsedFeedbackFlags {
  const args = input.args.slice();
  const errors: string[] = [];
  const help = false;

  if (args.length === 0) {
    errors.push("missing subcommand: expected one of rate|hide|star");
    return { help, errors };
  }

  const first = args[0]!;
  if (first === "--help" || first === "-h") {
    return { help: true, errors };
  }

  switch (first) {
    case "rate":
      return parseRateFlags(args.slice(1));
    case "hide":
      return parseHideFlags(args.slice(1));
    case "star":
      return parseStarFlags(args.slice(1));
    default:
      errors.push(`unknown subcommand: ${first}`);
      return { help, errors };
  }
}

function parseRateFlags(args: string[]): ParsedFeedbackFlags {
  const errors: string[] = [];
  let help = false;
  let direction: "up" | "down" = "up";
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--up":
        direction = "up";
        break;
      case "--down":
        direction = "down";
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        if (a.startsWith("--")) {
          errors.push(`unknown flag: ${a}`);
        } else {
          positionals.push(a);
        }
    }
  }

  if (help) {
    return { subcommand: "rate", help, errors };
  }

  let editionId: string | undefined;
  let storyId: string | undefined;

  if (positionals.length < 1) {
    errors.push("rate: missing edition_id");
  } else {
    editionId = positionals[0];
    if (!UUID_RE.test(editionId)) {
      errors.push(`rate: invalid edition_id UUID "${editionId}"`);
    }
  }

  if (positionals.length < 2) {
    errors.push("rate: missing story_id");
  } else {
    storyId = positionals[1];
    if (!UUID_RE.test(storyId)) {
      errors.push(`rate: invalid story_id UUID "${storyId}"`);
    }
  }

  if (errors.length > 0) {
    return { subcommand: "rate", help, errors };
  }

  return {
    subcommand: "rate",
    rate: {
      editionId: editionId!,
      storyId: storyId!,
      direction,
    },
    help,
    errors,
  };
}

function parseHideFlags(args: string[]): ParsedFeedbackFlags {
  const errors: string[] = [];
  let help = false;
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        if (a.startsWith("--")) {
          errors.push(`unknown flag: ${a}`);
        } else {
          positionals.push(a);
        }
    }
  }

  if (help) {
    return { subcommand: "hide", help, errors };
  }

  if (positionals.length < 1) {
    errors.push("hide: missing source_url");
    return { subcommand: "hide", help, errors };
  }

  return {
    subcommand: "hide",
    hide: { sourceUrl: positionals[0]! },
    help,
    errors,
  };
}

function parseStarFlags(args: string[]): ParsedFeedbackFlags {
  const errors: string[] = [];
  let help = false;
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        if (a.startsWith("--")) {
          errors.push(`unknown flag: ${a}`);
        } else {
          positionals.push(a);
        }
    }
  }

  if (help) {
    return { subcommand: "star", help, errors };
  }

  if (positionals.length < 1) {
    errors.push("star: missing chunk_id");
    return { subcommand: "star", help, errors };
  }

  return {
    subcommand: "star",
    star: { chunkId: positionals[0]! },
    help,
    errors,
  };
}

function errMsg(msg: unknown): string {
  return msg instanceof Error ? msg.message : String(msg);
}

async function runRate(
  deps: FeedbackDeps,
  log: (msg: string) => void,
  flags: FeedbackRateFlags,
): Promise<FeedbackCommandResult> {
  let edition;
  try {
    edition = await deps.editionRepo.getById(flags.editionId);
  } catch (err) {
    log(`feedback: edition lookup failed: ${errMsg(err)}`);
    return { exitCode: 1 };
  }
  if (!edition) {
    log(`feedback: edition not found: ${flags.editionId}`);
    return { exitCode: 1 };
  }

  try {
    const story = await deps.storyRepo.getById(flags.storyId);
    if (!story) {
      log(`feedback: story not found: ${flags.storyId}`);
      return { exitCode: 1 };
    }
  } catch (err) {
    log(`feedback: story lookup failed: ${errMsg(err)}`);
    return { exitCode: 1 };
  }

  const signal_kind = flags.direction === "up" ? "story_up" : "story_down";
  let rows;
  try {
    rows = await deps.signalRepo.createBatch([
      {
        signal_kind,
        edition_id: flags.editionId,
        story_id: flags.storyId,
        source_identity: null,
        payload: { direction: flags.direction },
      },
    ]);
  } catch (err) {
    log(`feedback: write failed: ${errMsg(err)}`);
    return { exitCode: 1 };
  }

  log(
    `feedback recorded: ${signal_kind} for edition=${flags.editionId} story=${flags.storyId}`,
  );
  return { exitCode: 0, signalId: rows[0]?.id };
}

async function runHide(
  deps: FeedbackDeps,
  log: (msg: string) => void,
  flags: FeedbackHideFlags,
): Promise<FeedbackCommandResult> {
  const edition = await deps.editionRepo.getByDate(todayDate());
  if (!edition) {
    log("feedback: no edition found to attach feedback to");
    return { exitCode: 1 };
  }
  return runHideWithEdition(deps, log, flags, edition);
}

async function runHideWithEdition(
  deps: FeedbackDeps,
  log: (msg: string) => void,
  flags: FeedbackHideFlags,
  edition: { id: string },
): Promise<FeedbackCommandResult> {
  const doc = await deps.docRepo.getByEditionAndUrl(edition.id, flags.sourceUrl);
  const sourceIdentity = deriveSourceIdentity({
    sourceUrl: flags.sourceUrl,
    sourceType: doc?.source_type ?? "article",
    publisher: doc?.publisher ?? null,
    metadata: doc?.metadata ?? null,
  });

  let rows;
  try {
    rows = await deps.signalRepo.createBatch([
      {
        signal_kind: "source_muted",
        edition_id: edition.id,
        source_url: flags.sourceUrl,
        source_identity: sourceIdentity,
        payload: { url: flags.sourceUrl },
      },
    ]);
  } catch (err) {
    log(`feedback: write failed: ${errMsg(err)}`);
    return { exitCode: 1 };
  }

  const sourceLabel = sourceIdentity ?? flags.sourceUrl;
  log(`feedback recorded: source_muted for source=${sourceLabel}`);
  return { exitCode: 0, signalId: rows[0]?.id };
}

async function runStar(
  deps: FeedbackDeps,
  log: (msg: string) => void,
  flags: FeedbackStarFlags,
): Promise<FeedbackCommandResult> {
  const chunk = await deps.chunkRepo.getById(flags.chunkId);
  if (!chunk) {
    log(`feedback: chunk not found: ${flags.chunkId}`);
    return { exitCode: 1 };
  }

  const doc = await deps.docRepo.getById(chunk.document_id);
  if (!doc) {
    log(`feedback: document not found for chunk: ${flags.chunkId}`);
    return { exitCode: 1 };
  }

  let rows;
  try {
    rows = await deps.signalRepo.createBatch([
      {
        signal_kind: "chunk_starred",
        edition_id: doc.edition_id,
        chunk_id: flags.chunkId,
        document_id: chunk.document_id,
        payload: {},
      },
    ]);
  } catch (err) {
    log(`feedback: write failed: ${errMsg(err)}`);
    return { exitCode: 1 };
  }

  log(`feedback recorded: chunk_starred for chunk=${flags.chunkId}`);
  return { exitCode: 0, signalId: rows[0]?.id };
}

export async function runFeedbackCommand(
  deps: FeedbackCommandDeps,
): Promise<FeedbackCommandResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const parsed = parseFeedbackFlags({ args: deps.args });

  if (parsed.help) {
    log(FEEDBACK_HELP);
    return { exitCode: 0 };
  }

  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) log(e);
    log(FEEDBACK_HELP);
    return { exitCode: 2 };
  }

  switch (parsed.subcommand) {
    case "rate":
      return runRate(deps, log, parsed.rate!);
    case "hide":
      return runHide(deps, log, parsed.hide!);
    case "star":
      return runStar(deps, log, parsed.star!);
    default:
      log("feedback: no subcommand");
      return { exitCode: 2 };
  }
}

export async function runFeedbackRate(
  deps: FeedbackDeps,
  editionId: string,
  storyId: string,
  direction: "up" | "down",
): Promise<FeedbackCommandResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  return runRate(deps, log, { editionId, storyId, direction });
}

export async function runFeedbackHide(
  deps: FeedbackDeps,
  sourceUrl: string,
  editionIdOverride?: string,
): Promise<FeedbackCommandResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  if (editionIdOverride) {
    const edition = await deps.editionRepo.getById(editionIdOverride);
    if (!edition) {
      log(`feedback: edition not found: ${editionIdOverride}`);
      return { exitCode: 1 };
    }
    return runHideWithEdition(deps, log, { sourceUrl }, edition);
  }
  return runHide(deps, log, { sourceUrl });
}

export async function runFeedbackStar(
  deps: FeedbackDeps,
  chunkId: string,
): Promise<FeedbackCommandResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  return runStar(deps, log, { chunkId });
}

export const FEEDBACK_HELP = `digestive feedback — record self-attributed feedback signals

Writes self-attributed feedback to the signals table so the same person
running PNIP can record reactions without touching the DB directly.
CLI-only; never read by the pipeline itself (see plan §65.3 Phase B).

Usage:
  digestive feedback <subcommand> [flags]

Subcommands:
  rate <edition_id> <story_id> [--up|--down]
      Record a story rating. --up (default) writes signal_kind='story_up';
      --down writes signal_kind='story_down'. Validates that the edition
      and story exist.

  hide <source_url>
      Record a source mute (signal_kind='source_muted'). Resolves today's
      edition and (if present) the matching document to derive
      source_identity; otherwise falls back to source_type='article'.

  star <chunk_id>
      Record chunk interest (signal_kind='chunk_starred'). Resolves the
      chunk -> document -> edition to populate edition_id and document_id.

Flags:
  --up                       rate: write story_up (default)
  --down                     rate: write story_down
  -h, --help                 show this help (top-level or per subcommand)

Exit codes:
  0   feedback recorded
  1   lookup failed (edition/story/chunk not found) or write error
  2   invalid flags / unknown subcommand

Positional args are required for each subcommand. edition_id and story_id
must be UUIDs; chunk_id is free-form text (document_chunks.id).
`;
