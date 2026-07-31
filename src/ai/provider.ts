export interface ProviderTextResult {
  content: string;
  model: string;
  provider: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface AiProvider {
  name: string;
  generateText(input: {
    prompt: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<ProviderTextResult>;
  /** Test-double compatibility only; production providers do not implement embeddings. */
  embed?: (input: { texts: string[]; model?: string }) => Promise<any>;
}

export interface ArtifactMetadata {
  promptId: string;
  promptVersion: number;
  model: string;
  provider: string;
  inputHash: string;
  createdAt: string;
}
