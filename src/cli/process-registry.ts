import { createPluginRegistry } from "../expansion/plugin-registry.js";
import type { PluginRegistry } from "../expansion/plugin-registry.js";
import { createYouTubePlugin } from "../expansion/youtube-plugin.js";
import { createRedditPlugin } from "../expansion/reddit-plugin.js";
import { createPodcastPlugin } from "../expansion/podcast-plugin.js";
import { createPdfPlugin } from "../expansion/pdf-plugin.js";
import { createArticlePlugin } from "../expansion/article-plugin.js";

export function buildPluginRegistry(): PluginRegistry {
  const registry = createPluginRegistry();
  registry.register(createYouTubePlugin());
  registry.register(createRedditPlugin());
  registry.register(createPodcastPlugin());
  registry.register(createPdfPlugin());
  registry.register(createArticlePlugin());
  return registry;
}
