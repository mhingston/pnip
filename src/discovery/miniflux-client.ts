export type MinifluxCategory = { id: number; title: string };

export type MinifluxFeed = { id: number; title: string };

export interface MinifluxEntry {
  id: number;
  feedId: number;
  title: string;
  url: string;
  hash?: string;
  publishedAt?: string;
  createdAt?: string;
  category?: MinifluxCategory | null;
}

export interface MinifluxEntriesResponse {
  total: number;
  entries: MinifluxEntry[];
}

export type MinifluxEntryStatus = "read" | "unread" | "all";

export interface ListMinifluxEntriesOptions {
  status?: MinifluxEntryStatus;
  limit?: number;
  afterEntryId?: number;
}

export interface MinifluxClient {
  /** List entries without changing their read state. */
  listEntries?(opts?: ListMinifluxEntriesOptions): Promise<MinifluxEntry[]>;
  /** @deprecated Use listEntries({ status: "unread" }) for unread-only callers. */
  listUnreadEntries(opts?: Omit<ListMinifluxEntriesOptions, "status">): Promise<MinifluxEntry[]>;
  /** Mark every entry in every subscribed feed as read. */
  markAllFeedsRead(): Promise<void>;
  markEntryRead(entryId: number): Promise<void>;
  markEntriesRead(entryIds: number[]): Promise<void>;
  health(): Promise<{ ok: boolean; status: number; body?: string }>;
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
  category?: MinifluxCategory | null;
}

interface RawMinifluxFeed {
  id: number;
  title: string;
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
    category: raw.category ?? null,
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
    async listEntries(listOpts?: ListMinifluxEntriesOptions): Promise<MinifluxEntry[]> {
      const params = new URLSearchParams();
      const status = listOpts?.status ?? "all";
      if (status === "all") {
        // Miniflux represents an all-state query as repeated status params;
        // there is no literal status=all value.
        params.append("status", "read");
        params.append("status", "unread");
      } else {
        params.set("status", status);
      }
      params.set("order", "id");
      params.set("direction", "asc");
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

    async listUnreadEntries(listOpts?: Omit<ListMinifluxEntriesOptions, "status">): Promise<MinifluxEntry[]> {
      return this.listEntries!({ ...listOpts, status: "unread" });
    },

    async markAllFeedsRead(): Promise<void> {
      const feedsUrl = `${base}/v1/feeds`;
      const feedsRes = await doFetch(feedsUrl, {
        method: "GET",
        headers: { "X-Auth-Token": token, Accept: "application/json" },
      });
      await ensureOk(feedsRes, feedsUrl, "GET");
      const feeds = (await feedsRes.json()) as RawMinifluxFeed[];

      // Miniflux exposes the operation per feed. Keep this sequential so a
      // large feed list does not turn the daily boundary into a burst of
      // concurrent writes. The operation is idempotent, so a partial failure
      // is safe to retry on the next discovery poll.
      for (const feed of feeds) {
        const url = `${base}/v1/feeds/${feed.id}/mark-all-as-read`;
        const res = await doFetch(url, {
          method: "PUT",
          headers: { "X-Auth-Token": token, Accept: "application/json" },
        });
        await ensureOk(res, url, "PUT");
      }
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

    async health(): Promise<{ ok: boolean; status: number; body?: string }> {
      const url = `${base}/v1/me`;
      try {
        const res = await doFetch(url, {
          method: "GET",
          headers: { "X-Auth-Token": token, Accept: "application/json" },
        });
        const text = await res.text();
        return {
          ok: res.ok,
          status: res.status,
          body: text.length > 200 ? text.slice(0, 200) : text,
        };
      } catch (err) {
        if (err instanceof MinifluxApiError) {
          return { ok: false, status: err.status, body: err.body };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, status: 0, body: msg };
      }
    },
  };
}
