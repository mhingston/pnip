import { createHash } from "node:crypto";
import type { AiProvider, ProviderEmbedResult, ProviderTextResult } from "./provider.js";

export interface FakeProviderOptions {
  text?: (prompt: string) => string;
  embed?: (text: string) => number[];
  throwNTimes?: number;
}

const VECTOR_LENGTH = 8;

function deterministicVector(text: string): number[] {
  const hex = createHash("sha256").update(text).digest("hex");
  const out: number[] = [];
  for (let i = 0; i < VECTOR_LENGTH; i++) {
    const chunk = hex.slice(i * 8, i * 8 + 8);
    out.push(parseInt(chunk, 16) / 0x100000000);
  }
  return out;
}

export function createFakeProvider(opts: FakeProviderOptions = {}): AiProvider {
  let calls = 0;
  const throwNTimes = opts.throwNTimes ?? 0;
  const textFn = opts.text ?? ((prompt: string) => "FAKE:" + prompt);
  const embedFn = opts.embed ?? deterministicVector;

  return {
    name: "fake",
    async generateText(input): Promise<ProviderTextResult> {
      calls++;
      if (calls <= throwNTimes) {
        throw new Error("fake boom");
      }
      return {
        content: textFn(input.prompt),
        model: "fake-text",
        provider: "fake",
      };
    },
    async embed(input): Promise<ProviderEmbedResult> {
      return {
        vectors: input.texts.map(embedFn),
        model: "fake-embed",
        provider: "fake",
      };
    },
  };
}
