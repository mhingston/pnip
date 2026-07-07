import { describe, it, expect } from "vitest";
import {
  createMinifluxClient,
  MinifluxApiError,
  type MinifluxClient,
  type MinifluxEntry,
} from "./miniflux-client.js";

type RecordedCall = {
  url: string;
  init: RequestInit | undefined;
};

function makeFakeFetch(
  respond: (call: RecordedCall) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const f = ((input: string | URL | Request, init?: RequestInit) => {
    let url: string;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.toString();
    else url = input.url;
    const call: RecordedCall = { url, init };
    calls.push(call);
    return Promise.resolve(respond(call));
  }) as typeof fetch;
  return { fetch: f, calls };
}

function header(headers: HeadersInit | undefined, name: string): string | undefined {
  if (headers === undefined) return undefined;
  return new Headers(headers).get(name) ?? undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const TOKEN = "test-token-abc";

const TWO_RAW = {
  total: 2,
  entries: [
    {
      id: 10,
      feed_id: 3,
      title: "T",
      url: "https://x/y",
      hash: "h",
      published_at: "2026-01-01T00:00:00Z",
      created_at: "2026-01-02T00:00:00Z",
    },
    {
      id: 11,
      feed_id: 4,
      title: "T2",
      url: "https://x/z",
    },
  ],
};

describe("miniflux-client", () => {
  describe("listUnreadEntries", () => {
    it("GETs /v1/entries with status=unread, sends X-Auth-Token, maps snake→camelCase", async () => {
      const { fetch, calls } = makeFakeFetch(() => jsonResponse(TWO_RAW));
      const client: MinifluxClient = createMinifluxClient({
        baseUrl: "http://127.0.0.1:8080",
        token: TOKEN,
        fetchImpl: fetch,
      });

      const entries: MinifluxEntry[] = await client.listUnreadEntries();

      expect(calls).toHaveLength(1);
      const u = new URL(calls[0].url);
      expect(u.pathname).toBe("/v1/entries");
      expect(u.searchParams.get("status")).toBe("unread");
      expect(header(calls[0].init?.headers, "X-Auth-Token")).toBe(TOKEN);
      expect(header(calls[0].init?.headers, "Accept")).toBe("application/json");
      expect((calls[0].init?.method ?? "GET")).toBe("GET");

      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({
        id: 10,
        feedId: 3,
        title: "T",
        url: "https://x/y",
        hash: "h",
        publishedAt: "2026-01-01T00:00:00Z",
        createdAt: "2026-01-02T00:00:00Z",
      });
      expect(entries[0].feedId).toBe(3);
      expect(entries[0].publishedAt).toBe("2026-01-01T00:00:00Z");
      expect(entries[1]).toEqual({
        id: 11,
        feedId: 4,
        title: "T2",
        url: "https://x/z",
        hash: undefined,
        publishedAt: undefined,
        createdAt: undefined,
      });
    });

    it("encodes limit and afterEntryId as limit / after_entry_id query params", async () => {
      const { fetch, calls } = makeFakeFetch(() => jsonResponse({ total: 0, entries: [] }));
      const client = createMinifluxClient({
        baseUrl: "http://127.0.0.1:8080",
        token: TOKEN,
        fetchImpl: fetch,
      });

      await client.listUnreadEntries({ limit: 50, afterEntryId: 123 });

      const u = new URL(calls[0].url);
      expect(u.searchParams.get("status")).toBe("unread");
      expect(u.searchParams.get("limit")).toBe("50");
      expect(u.searchParams.get("after_entry_id")).toBe("123");
    });

    it("omits limit/after_entry_id params when not provided", async () => {
      const { fetch, calls } = makeFakeFetch(() => jsonResponse({ total: 0, entries: [] }));
      const client = createMinifluxClient({
        baseUrl: "http://127.0.0.1:8080",
        token: TOKEN,
        fetchImpl: fetch,
      });

      await client.listUnreadEntries();

      const u = new URL(calls[0].url);
      expect(u.searchParams.has("limit")).toBe(false);
      expect(u.searchParams.has("after_entry_id")).toBe(false);
    });

    it("trims a trailing slash on baseUrl (no double slash)", async () => {
      const { fetch, calls } = makeFakeFetch(() => jsonResponse({ total: 0, entries: [] }));
      const client = createMinifluxClient({
        baseUrl: "http://h:8080/",
        token: TOKEN,
        fetchImpl: fetch,
      });

      await client.listUnreadEntries();

      const u = new URL(calls[0].url);
      expect(u.origin).toBe("http://h:8080");
      expect(u.pathname).toBe("/v1/entries");
      expect(calls[0].url).not.toContain("8080//");
    });
  });

  describe("markEntryRead / markEntriesRead", () => {
    it("markEntryRead(10) PUTs /v1/entries with ids=[10] status=read", async () => {
      const { fetch, calls } = makeFakeFetch(() => jsonResponse({}, 200));
      const client = createMinifluxClient({
        baseUrl: "http://127.0.0.1:8080",
        token: TOKEN,
        fetchImpl: fetch,
      });

      await client.markEntryRead(10);

      expect(calls).toHaveLength(1);
      const call = calls[0];
      expect(call.init?.method).toBe("PUT");
      const u = new URL(call.url);
      expect(u.pathname).toBe("/v1/entries");
      expect(header(call.init?.headers, "X-Auth-Token")).toBe(TOKEN);
      expect(header(call.init?.headers, "Content-Type")).toBe("application/json");
      expect(header(call.init?.headers, "Accept")).toBe("application/json");
      expect(JSON.parse(call.init?.body as string)).toEqual({ entry_ids: [10], status: "read" });
    });

    it("markEntriesRead([10,11]) PUTs entry_ids=[10,11] status=read", async () => {
      const { fetch, calls } = makeFakeFetch(() => jsonResponse({}, 200));
      const client = createMinifluxClient({
        baseUrl: "http://127.0.0.1:8080",
        token: TOKEN,
        fetchImpl: fetch,
      });

      await client.markEntriesRead([10, 11]);

      expect(calls).toHaveLength(1);
      expect(calls[0].init?.method).toBe("PUT");
      expect(JSON.parse(calls[0].init?.body as string)).toEqual({ entry_ids: [10, 11], status: "read" });
    });

    it("markEntriesRead([]) does not call fetch", async () => {
      const { fetch, calls } = makeFakeFetch(() => jsonResponse({}, 200));
      const client = createMinifluxClient({
        baseUrl: "http://127.0.0.1:8080",
        token: TOKEN,
        fetchImpl: fetch,
      });

      await client.markEntriesRead([]);

      expect(calls).toHaveLength(0);
    });
  });

  describe("error handling", () => {
    it("listUnreadEntries throws MinifluxApiError on 401 with status/statusText/body/url/method", async () => {
      const { fetch, calls } = makeFakeFetch(
        () => new Response('{"error":"unauthorized"}', { status: 401, statusText: "Unauthorized" }),
      );
      const client = createMinifluxClient({
        baseUrl: "http://127.0.0.1:8080",
        token: TOKEN,
        fetchImpl: fetch,
      });

      let caught: unknown;
      try {
        await client.listUnreadEntries();
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(MinifluxApiError);
      const err = caught as MinifluxApiError;
      expect(err.status).toBe(401);
      expect(err.statusText).toBe("Unauthorized");
      expect(err.body).toContain("unauthorized");
      expect(err.method).toBe("GET");
      expect(err.url).toBe(calls[0].url);
      expect(err.message).toContain("401");
    });

    it("markEntriesRead throws MinifluxApiError on 500 with status/statusText/body/url/method", async () => {
      const { fetch, calls } = makeFakeFetch(
        () => new Response("oops", { status: 500, statusText: "Internal Server Error" }),
      );
      const client = createMinifluxClient({
        baseUrl: "http://127.0.0.1:8080",
        token: TOKEN,
        fetchImpl: fetch,
      });

      let caught: unknown;
      try {
        await client.markEntriesRead([10]);
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(MinifluxApiError);
      const err = caught as MinifluxApiError;
      expect(err.status).toBe(500);
      expect(err.statusText).toBe("Internal Server Error");
      expect(err.body).toBe("oops");
      expect(err.method).toBe("PUT");
      expect(err.url).toBe(calls[0].url);
    });

    it("propagates network errors when fetch rejects", async () => {
      const failure = new Error("network down");
      const f = (() => Promise.reject(failure)) as unknown as typeof fetch;
      const client = createMinifluxClient({
        baseUrl: "http://127.0.0.1:8080",
        token: TOKEN,
        fetchImpl: f,
      });

      await expect(client.listUnreadEntries()).rejects.toBe(failure);
    });
  });

  it("MinifluxApiError is an Error with expected name", () => {
    const err = new MinifluxApiError(503, "Service Unavailable", "body", "u", "GET");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("MinifluxApiError");
    expect(err.status).toBe(503);
    expect(err.statusText).toBe("Service Unavailable");
    expect(err.body).toBe("body");
    expect(err.url).toBe("u");
    expect(err.method).toBe("GET");
  });

  describe("health", () => {
    it("GETs /v1/me with X-Auth-Token and returns ok=true on 200", async () => {
      const { fetch, calls } = makeFakeFetch(() =>
        new Response('{"id":1,"username":"admin"}', { status: 200 }),
      );
      const client = createMinifluxClient({
        baseUrl: "http://127.0.0.1:8080",
        token: TOKEN,
        fetchImpl: fetch,
      });

      const h = await client.health();

      expect(calls).toHaveLength(1);
      const u = new URL(calls[0].url);
      expect(u.pathname).toBe("/v1/me");
      expect(header(calls[0].init?.headers, "X-Auth-Token")).toBe(TOKEN);
      expect(h.ok).toBe(true);
      expect(h.status).toBe(200);
      expect(h.body).toContain("admin");
    });

    it("returns ok=false with the status and body on 401", async () => {
      const { fetch } = makeFakeFetch(
        () => new Response('{"error":"unauthorized"}', { status: 401 }),
      );
      const client = createMinifluxClient({
        baseUrl: "http://127.0.0.1:8080",
        token: TOKEN,
        fetchImpl: fetch,
      });

      const h = await client.health();

      expect(h.ok).toBe(false);
      expect(h.status).toBe(401);
      expect(h.body).toContain("unauthorized");
    });

    it("returns ok=false with status=0 and an error message when fetch throws", async () => {
      const f = (() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;
      const client = createMinifluxClient({
        baseUrl: "http://127.0.0.1:8080",
        token: TOKEN,
        fetchImpl: f,
      });

      const h = await client.health();

      expect(h.ok).toBe(false);
      expect(h.status).toBe(0);
      expect(h.body).toBe("network down");
    });
  });
});
