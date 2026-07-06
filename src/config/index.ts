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
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  EMAIL_RECIPIENT: z.string().optional(),
  NOTEBOOKLM_OUTPUT_DIR: z.string().optional(),
  NOTEBOOKLM_HEADLESS: z.string().optional(),
  EDITION_SCHEDULE: z.string().optional(),
  REDDIT_REFRESH_STRATEGY: z.string().optional(),
  WORKER_CONCURRENCY: z.string().optional(),
  RETRY_MAX_ATTEMPTS: z.string().optional(),
});

export type Config = z.infer<typeof configSchema>;

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
