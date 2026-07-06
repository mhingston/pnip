import { generateText, embedMany } from "ai";
import { openai } from "@ai-sdk/openai";
import type { AiProvider, ProviderEmbedResult, ProviderTextResult } from "./provider.js";

export interface VercelAiProviderOptions {
  textModel?: string;
  embeddingModel?: string;
}

export function createVercelAiProvider(
  opts: VercelAiProviderOptions = {},
): AiProvider {
  const textModel = opts.textModel ?? "gpt-4o-mini";
  const embeddingModel = opts.embeddingModel ?? "text-embedding-3-small";

  return {
    name: "openai",
    async generateText(input): Promise<ProviderTextResult> {
      const result = await generateText({
        model: openai(input.model ?? textModel),
        prompt: input.prompt,
        maxOutputTokens: input.maxTokens,
        temperature: input.temperature,
      });
      return {
        content: result.text,
        model: result.response.modelId,
        provider: "openai",
        usage: {
          promptTokens: result.usage.inputTokens ?? undefined,
          completionTokens: result.usage.outputTokens ?? undefined,
        },
      };
    },
    async embed(input): Promise<ProviderEmbedResult> {
      const result = await embedMany({
        model: openai.embedding(input.model ?? embeddingModel),
        values: input.texts,
      });
      return {
        vectors: result.embeddings,
        model: input.model ?? embeddingModel,
        provider: "openai",
      };
    },
  };
}
