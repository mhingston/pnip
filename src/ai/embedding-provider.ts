export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  provider: string;
  dimension: number;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimension: number;
  embed(texts: string[]): Promise<EmbeddingResult>;
}
