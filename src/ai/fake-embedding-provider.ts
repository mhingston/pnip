import { createHash } from "node:crypto";
import type { EmbeddingProvider, EmbeddingResult } from "./embedding-provider.js";

export interface FakeEmbeddingProviderOptions {
  dimension?: number;
  model?: string;
  name?: string;
  embed?: (text: string) => number[];
}

const DEFAULT_DIM = 8;

function deterministicVector(text: string, dim: number): number[] {
  const hex = createHash("sha256").update(text).digest("hex");
  const out: number[] = [];
  for (let i = 0; i < dim; i++) {
    const chunk = hex.slice((i * 8) % hex.length, ((i * 8) % hex.length) + 8);
    out.push((parseInt(chunk || "0", 16) % 1000) / 1000);
  }
  return out;
}

export function createFakeEmbeddingProvider(
  opts: FakeEmbeddingProviderOptions = {},
): EmbeddingProvider {
  const dimension = opts.dimension ?? DEFAULT_DIM;
  const model = opts.model ?? "fake-embed";
  const name = opts.name ?? "fake";
  const embedFn = opts.embed ?? ((text: string) => deterministicVector(text, dimension));

  return {
    name,
    dimension,
    async embed(texts: string[]): Promise<EmbeddingResult> {
      return {
        vectors: texts.map(embedFn),
        model,
        provider: name,
        dimension,
      };
    },
  };
}
