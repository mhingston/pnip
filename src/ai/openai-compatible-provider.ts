import type { AiProvider, ProviderEmbedResult, ProviderTextResult } from "./provider.js";

export interface OpenAICompatibleProviderOptions {
  baseURL: string;
  apiKey: string;
  textModel?: string;
  name?: string;
}

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface ChatChoice {
  index: number;
  message: { role: string; content: string; reasoning_content?: string };
  finish_reason: string;
}

interface ChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export function createOpenAICompatibleProvider(
  opts: OpenAICompatibleProviderOptions,
): AiProvider {
  const providerName = opts.name ?? "openai-compatible";
  const textModel = opts.textModel ?? "Free";
  const baseURL = opts.baseURL.replace(/\/+$/, "");

  return {
    name: providerName,
    async generateText(input): Promise<ProviderTextResult> {
      const model = input.model ?? textModel;
      const body: Record<string, unknown> = {
        model,
        messages: [{ role: "user", content: input.prompt } satisfies ChatMessage],
        stream: false,
      };
      if (typeof input.maxTokens === "number") body.max_tokens = input.maxTokens;
      if (typeof input.temperature === "number") body.temperature = input.temperature;

      const res = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `openai-compatible ${baseURL}/chat/completions ${res.status}: ${text.slice(0, 500)}`,
        );
      }
      const data = (await res.json()) as ChatResponse;
      const choice = data.choices?.[0];
      if (!choice) {
        throw new Error(`openai-compatible returned no choices: ${JSON.stringify(data).slice(0, 500)}`);
      }
      const reasoning = choice.message.reasoning_content ?? "";
      const content = choice.message.content ?? "";
      const merged = (reasoning + (content && reasoning ? "\n\n" : "") + content).trim();
      return {
        content: merged,
        model: data.model ?? model,
        provider: providerName,
        usage: data.usage
          ? {
              promptTokens: data.usage.prompt_tokens,
              completionTokens: data.usage.completion_tokens,
            }
          : undefined,
      };
    },
    async embed(input): Promise<ProviderEmbedResult> {
      const model = input.model ?? "text-embedding-3-small";
      const res = await fetch(`${baseURL}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({ model, input: input.texts }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `openai-compatible ${baseURL}/embeddings ${res.status}: ${text.slice(0, 500)}`,
        );
      }
      const data = (await res.json()) as {
        model: string;
        data: { embedding: number[]; index: number }[];
      };
      const vectors = new Array<number[]>(input.texts.length);
      for (const item of data.data) {
        vectors[item.index] = item.embedding;
      }
      for (let i = 0; i < vectors.length; i++) {
        if (!vectors[i]) throw new Error(`openai-compatible embed missing index ${i}`);
      }
      return { vectors, model: data.model ?? model, provider: providerName };
    },
  };
}
