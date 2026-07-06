export interface ProviderTextResult {
  content: string;
  model: string;
  provider: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface ProviderEmbedResult {
  vectors: number[][];
  model: string;
  provider: string;
}

export interface AiProvider {
  name: string;
  generateText(input: {
    prompt: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<ProviderTextResult>;
  embed(input: { texts: string[]; model?: string }): Promise<ProviderEmbedResult>;
}

export interface ArtifactMetadata {
  promptId: string;
  promptVersion: number;
  model: string;
  provider: string;
  inputHash: string;
  createdAt: string;
}
