export interface ExpandContext {
  url: string;
  editionId: string;
  discoveryEventId: string;
  /** The title supplied by Miniflux, used when page extraction has no title. */
  title?: string;
}

export interface SectionData {
  order: number;
  heading?: string;
  section_type?: string;
  content_markdown?: string;
  content_text?: string;
}

export interface ExpandResult {
  title: string;
  content: string;
  plainText: string;
  sourceType: string;
  canonicalUrl?: string;
  subtitle?: string;
  authors?: string[];
  publisher?: string;
  publishedAt?: Date;
  language?: string;
  sections: SectionData[];
  metadata?: Record<string, unknown>;
}

export interface ExpansionPlugin {
  readonly name: string;
  supports(url: string): boolean;
  expand(context: ExpandContext): Promise<ExpandResult>;
}
