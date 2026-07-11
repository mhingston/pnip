import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const configSchema = z.object({
  DATABASE_URL: z
    .string()
    .regex(/^postgres/, "must begin with 'postgres'"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  TEST_DATABASE_URL: z.string().optional(),
  MINIFLUX_URL: z.string().optional(),
  MINIFLUX_API_TOKEN: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
  AI_PROVIDER: z.enum(["openai", "fake", "openai-compatible"]).default("openai"),
  AI_TEXT_MODEL: z.string().optional(),
  EMBEDDING_MODEL: z.string().optional(),
  EMBEDDING_CACHE_DIR: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  EMAIL_RECIPIENT: z.string().optional(),
  NOTEBOOKLM_OUTPUT_DIR: z.string().optional(),
  NOTEBOOKLM_HEADLESS: z.string().optional(),
  NOTEBOOKLM_MAX_SOURCES_PER_NOTEBOOK: z.coerce.number().int().positive().optional(),
  EDITION_SCHEDULE: z.string().optional(),
  REDDIT_REFRESH_STRATEGY: z.string().optional(),
  FABRIC_BIN: z.string().optional(),
  MARKITDOWN_BIN: z.string().optional(),
  WORKER_CONCURRENCY: z.string().optional(),
  RETRY_MAX_ATTEMPTS: z.string().optional(),
  DOCTOR_FAILED_THRESHOLD: z.coerce.number().int().positive().optional(),
  DIGEST_BIAS_ENABLED: z.enum(["true", "false"]).optional(),
  DIGEST_TARGET_READING_MINUTES: z.coerce.number().int().positive().optional(),
  DIGEST_QUIET_EDITION_REASON: z
    .enum(["low_significance", "low_novelty"])
    .optional(),
  YOUTUBE_FOCUS_CHANNELS: z.string().optional(),
  PARTITION_CONFIG: z.string().optional(),
});

export type Config = z.infer<typeof configSchema>;

export interface PartitionConfigEntry {
  min_articles?: number;
  enabled?: boolean;
  with_podcast?: boolean;
  category?: string;
  category_id?: number;
}

export type PartitionConfig = Record<string, PartitionConfigEntry>;

/**
 * Parse the display names/handles used to identify the operator's preferred
 * YouTube channels. Matching is done downstream against both the channel
 * author name and URL because oEmbed does not expose the same identifier
 * consistently for every channel.
 */
export function parseYoutubeFocusChannels(
  raw: string | undefined,
): string[] {
  if (!raw || raw.trim() === "") return [];
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );
}

export function parsePartitionConfig(
  raw: string | undefined,
): PartitionConfig {
  if (!raw || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid PARTITION_CONFIG: ${msg}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid PARTITION_CONFIG: must be a JSON object");
  }
  const result: PartitionConfig = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(
        `Invalid PARTITION_CONFIG: entry "${key}" must be an object`,
      );
    }
    const entry: PartitionConfigEntry = {};
    const v = value as Record<string, unknown>;
    if ("min_articles" in v) {
      const n = v.min_articles;
      if (
        typeof n !== "number" ||
        !Number.isInteger(n) ||
        n < 0 ||
        !Number.isFinite(n)
      ) {
        throw new Error(
          `Invalid PARTITION_CONFIG: ${key}.min_articles must be a non-negative integer`,
        );
      }
      entry.min_articles = n;
    }
    if ("enabled" in v) {
      if (typeof v.enabled !== "boolean") {
        throw new Error(
          `Invalid PARTITION_CONFIG: ${key}.enabled must be a boolean`,
        );
      }
      entry.enabled = v.enabled;
    }
    if ("with_podcast" in v) {
      if (typeof v.with_podcast !== "boolean") {
        throw new Error(
          `Invalid PARTITION_CONFIG: ${key}.with_podcast must be a boolean`,
        );
      }
      entry.with_podcast = v.with_podcast;
    }
    if ("category" in v) {
      if (typeof v.category !== "string" || v.category.length === 0) {
        throw new Error(
          `Invalid PARTITION_CONFIG: ${key}.category must be a non-empty string`,
        );
      }
      entry.category = v.category;
    }
    if ("category_id" in v) {
      const cid = v.category_id;
      if (typeof cid !== "number" || !Number.isInteger(cid) || cid <= 0) {
        throw new Error(
          `Invalid PARTITION_CONFIG: ${key}.category_id must be a positive integer`,
        );
      }
      entry.category_id = cid;
    }
    result[key] = entry;
  }
  return result;
}

let cached: Config | undefined;

export function loadConfig(opts?: { force?: boolean }): Config {
  if (cached && !opts?.force) return cached;
  const parsed = configSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetConfigCache(): void {
  cached = undefined;
}
