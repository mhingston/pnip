import type { ExpansionPlugin } from "./types.js";

export interface PluginRegistry {
  register(plugin: ExpansionPlugin): void;
  select(url: string): ExpansionPlugin | undefined;
  list(): ExpansionPlugin[];
}

export function createPluginRegistry(): PluginRegistry {
  const plugins: ExpansionPlugin[] = [];

  return {
    register(plugin) {
      plugins.push(plugin);
    },

    select(url) {
      return plugins.find((p) => p.supports(url));
    },

    list() {
      return plugins.slice();
    },
  };
}
