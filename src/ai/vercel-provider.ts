import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import type { AiProvider, ProviderTextResult } from "./provider.js";

export interface VercelAiProviderOptions {
  textModel?: string;
}

export function createVercelAiProvider(
  opts: VercelAiProviderOptions = {},
): AiProvider {
  const textModel = opts.textModel ?? "gpt-4o-mini";

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
  };
}
