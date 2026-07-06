export interface MinifluxEntry {
  id: number;
  feedId: number;
  title: string;
  url: string;
  hash?: string;
  publishedAt?: string;
  createdAt?: string;
}

export interface MinifluxEntriesResponse {
  total: number;
  entries: MinifluxEntry[];
}

export interface MinifluxClient {
  listUnreadEntries(opts?: { limit?: number; afterEntryId?: number }): Promise<MinifluxEntry[]>;
  markEntryRead(entryId: number): Promise<void>;
  markEntriesRead(entryIds: number[]): Promise<void>;
}

export class MinifluxApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly body: string;
  readonly url: string;
  readonly method: string;

  constructor(status: number, statusText: string, body: string, url: string, method: string) {
    super(`Miniflux API ${method} ${url} failed: ${status} ${statusText}`);
    this.name = "MinifluxApiError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
    this.url = url;
    this.method = method;
  }
}

interface RawMinifluxEntry {
  id: number;
  feed_id: number;
  title: string;
  url: string;
  hash?: string;
  published_at?: string;
  created_at?: string;
}

interface RawEntriesResponse {
  total: number;
  entries: RawMinifluxEntry[];
}

function mapEntry(raw: RawMinifluxEntry): MinifluxEntry {
  return {
    id: raw.id,
    feedId: raw.feed_id,
    title: raw.title,
    url: raw.url,
    hash: raw.hash,
    publishedAt: raw.published_at,
    createdAt: raw.created_at,
  };
}

export function createMinifluxClient(opts: {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}): MinifluxClient {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const token = opts.token;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;

  async function ensureOk(res: Response, url: string, method: string): Promise<void> {
    if (!res.ok) {
      const body = await res.text();
      throw new MinifluxApiError(res.status, res.statusText, body, url, method);
    }
  }

  return {
    async listUnreadEntries(listOpts?: { limit?: number; afterEntryId?: number }): Promise<MinifluxEntry[]> {
      const params = new URLSearchParams();
      params.set("status", "unread");
      if (listOpts?.limit !== undefined) params.set("limit", String(listOpts.limit));
      if (listOpts?.afterEntryId !== undefined) params.set("after_entry_id", String(listOpts.afterEntryId));
      const url = `${base}/v1/entries?${params.toString()}`;

      const res = await doFetch(url, {
        method: "GET",
        headers: { "X-Auth-Token": token, Accept: "application/json" },
      });
      await ensureOk(res, url, "GET");
      const raw = (await res.json()) as RawEntriesResponse;
      return raw.entries.map(mapEntry);
    },

    async markEntryRead(entryId: number): Promise<void> {
      await this.markEntriesRead([entryId]);
    },

    async markEntriesRead(entryIds: number[]): Promise<void> {
      if (entryIds.length === 0) return;
      const url = `${base}/v1/entries`;
      const res = await doFetch(url, {
        method: "PUT",
        headers: {
          "X-Auth-Token": token,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ entry_ids: entryIds, status: "read" }),
      });
      await ensureOk(res, url, "PUT");
    },
  };
}
