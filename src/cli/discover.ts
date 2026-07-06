import type { DiscoveryService, DiscoveryResult } from "../discovery/discovery-service.js";
import type { MinifluxClient } from "../discovery/miniflux-client.js";

export interface DiscoverCommandDeps {
  service: DiscoveryService;
  miniflux: MinifluxClient;
  editionDate?: string | Date;
  log?: (msg: string) => void;
}

export interface DiscoverCommandResult {
  exitCode: number;
  result?: DiscoveryResult;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function runDiscoverCommand(
  deps: DiscoverCommandDeps,
): Promise<DiscoverCommandResult> {
  const log = deps.log ?? ((m) => console.log(m));
  try {
    const result = await deps.service.discover({
      editionDate: deps.editionDate ?? today(),
      miniflux: deps.miniflux,
    });
    log(
      `Discovered ${result.total} entries (created=${result.created}, duplicates=${result.duplicates}, enqueued=${result.enqueued}, failed=${result.failed}) for edition ${result.editionId}`,
    );
    return { exitCode: 0, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`discover failed: ${msg}`);
    return { exitCode: 1 };
  }
}
