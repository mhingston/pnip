import { createHash } from "node:crypto";
import type { AiProvider, ArtifactMetadata } from "./provider.js";
import type { PromptVersion } from "../database/kysely.js";

export interface PromptExecutionService {
  execute(input: {
    promptVersion: PromptVersion;
    variables: Record<string, string>;
    provider: AiProvider;
    model?: string;
  }): Promise<ArtifactMetadata & { content: string }>;
}

export interface PromptExecutionOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
}

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(PLACEHOLDER_RE, (_, key: string) => variables[key] ?? "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createPromptExecutionService(
  opts: PromptExecutionOptions = {},
): PromptExecutionService {
  const maxAttempts = opts.maxAttempts ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 50;

  return {
    async execute(input) {
      const rendered = renderTemplate(input.promptVersion.template, input.variables);
      const inputHash = createHash("sha256").update(rendered).digest("hex");

      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const result = await input.provider.generateText({
            prompt: rendered,
            model: input.model,
          });
          return {
            content: result.content,
            promptId: input.promptVersion.id,
            promptVersion: input.promptVersion.version,
            model: result.model,
            provider: result.provider,
            inputHash,
            createdAt: new Date().toISOString(),
          };
        } catch (err) {
          lastError = err;
          if (attempt < maxAttempts) {
            await sleep(retryDelayMs);
          }
        }
      }
      throw lastError;
    },
  };
}
