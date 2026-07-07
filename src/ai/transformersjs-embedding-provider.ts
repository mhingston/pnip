import type { EmbeddingProvider, EmbeddingResult } from "./embedding-provider.js";

export const TRANSFORMERS_DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";
export const TRANSFORMERS_DEFAULT_DIMENSION = 384;

export interface TransformersJsEmbeddingProviderOptions {
  model?: string;
  cacheDir?: string;
}

interface FeatureExtractionPipeline {
  (text: string | string[], options?: Record<string, unknown>): Promise<unknown>;
}

interface TransformersModule {
  pipeline: (
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ) => Promise<FeatureExtractionPipeline>;
  env: {
    cacheDir?: string;
  };
}

export function createTransformersJsEmbeddingProvider(
  opts: TransformersJsEmbeddingProviderOptions = {},
): EmbeddingProvider {
  const modelName = opts.model ?? TRANSFORMERS_DEFAULT_MODEL;
  let pipelinePromise: Promise<FeatureExtractionPipeline> | undefined;

  async function getPipeline(): Promise<FeatureExtractionPipeline> {
    if (!pipelinePromise) {
      pipelinePromise = (async () => {
        const mod = (await import("@huggingface/transformers")) as unknown as TransformersModule;
        const cacheDir = opts.cacheDir ?? mod.env.cacheDir;
        return mod.pipeline("feature-extraction", modelName, {
          pooling: "mean",
          normalize: true,
          ...(cacheDir ? { cache_dir: cacheDir } : {}),
        });
      })();
    }
    return pipelinePromise;
  }

  function tensorToVectors(output: unknown): number[][] {
    const t = output as { tolist?: () => unknown; data?: Float32Array; dims?: readonly number[] };
    if (typeof t.tolist === "function") {
      const arr = t.tolist() as unknown;
      if (!Array.isArray(arr)) {
        throw new Error("unexpected feature-extraction output shape");
      }
      if (arr.length === 0) return [];
      const first = arr[0];
      if (!Array.isArray(first)) {
        throw new Error("unexpected feature-extraction output: expected [batch, dim] or [batch, tokens, dim]");
      }
      const inner = first[0];
      if (typeof inner === "number") {
        return arr as number[][];
      }
      if (Array.isArray(inner) && typeof inner[0] === "number") {
        return (arr as number[][][]).map((row) => row[0] as unknown as number[]);
      }
      throw new Error("unexpected feature-extraction output shape");
    }
    if (t.data && t.dims && Array.isArray(t.dims) && t.dims.length >= 2) {
      const batch = t.dims[0];
      const dim = t.dims[t.dims.length - 1];
      const vectors: number[][] = [];
      for (let b = 0; b < batch; b++) {
        const row: number[] = [];
        for (let d = 0; d < dim; d++) {
          row.push(t.data[b * dim + d]);
        }
        vectors.push(row);
      }
      return vectors;
    }
    throw new Error("unrecognized feature-extraction output");
  }

  return {
    name: "transformersjs",
    dimension: TRANSFORMERS_DEFAULT_DIMENSION,
    async embed(texts: string[]): Promise<EmbeddingResult> {
      if (texts.length === 0) {
        return { vectors: [], model: modelName, provider: "transformersjs", dimension: TRANSFORMERS_DEFAULT_DIMENSION };
      }
      const pipe = await getPipeline();
      const output = await pipe(texts, { pooling: "mean", normalize: true });
      const vectors = tensorToVectors(output);
      if (vectors.length !== texts.length) {
        throw new Error(
          `embedding count mismatch: expected ${texts.length}, got ${vectors.length}`,
        );
      }
      const dim = vectors[0]?.length ?? 0;
      if (dim !== TRANSFORMERS_DEFAULT_DIMENSION) {
        throw new Error(
          `embedding dimension mismatch: model ${modelName} returned ${dim}, expected ${TRANSFORMERS_DEFAULT_DIMENSION}`,
        );
      }
      return {
        vectors,
        model: modelName,
        provider: "transformersjs",
        dimension: dim,
      };
    },
  };
}
