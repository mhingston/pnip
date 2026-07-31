import { createHash } from "node:crypto";
import type { AiProvider, ProviderTextResult } from "./provider.js";

export interface FakeProviderOptions {
  text?: (prompt: string) => string;
  throwNTimes?: number;
}

export function createFakeProvider(opts: FakeProviderOptions = {}): AiProvider {
  let calls = 0;
  const throwNTimes = opts.throwNTimes ?? 0;
  const textFn = opts.text ?? ((prompt: string) => "FAKE:" + prompt);

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
  };
}
