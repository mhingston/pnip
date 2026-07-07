import { describe, it, expect, vi } from "vitest";
import { createResendClient, type FetchLike } from "./resend-client.js";

function makeFetch(
  impl: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
    status: number;
    ok: boolean;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }>,
): FetchLike {
  return vi.fn(impl) as unknown as FetchLike;
}

describe("createResendClient", () => {
  it("throws when apiKey is missing", () => {
    expect(() => createResendClient({ apiKey: "" })).toThrow();
    expect(() => createResendClient({ apiKey: "x" })).not.toThrow();
  });

  it("posts to /emails with Bearer auth and the request body", async () => {
    let capturedUrl = "";
    let capturedInit: { method?: string; headers?: Record<string, string>; body?: string } | undefined;
    const fakeFetch = makeFetch(async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return {
        status: 200,
        ok: true,
        json: async () => ({ id: "msg-1" }),
        text: async () => "",
      };
    });
    const client = createResendClient({ apiKey: "re_test", fetchImpl: fakeFetch });
    const res = await client.sendEmail({
      from: "RSS Digest <from@example.com>",
      to: ["to@example.com"],
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.messageId).toBe("msg-1");
    expect(capturedUrl).toBe("https://api.resend.com/emails");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.headers?.["Authorization"]).toBe("Bearer re_test");
    const body = JSON.parse(capturedInit?.body ?? "{}");
    expect(body.from).toBe("RSS Digest <from@example.com>");
    expect(body.to).toEqual(["to@example.com"]);
    expect(body.subject).toBe("Hi");
    expect(body.html).toBe("<p>Hi</p>");
    expect(body.text).toBe("Hi");
  });

  it("appends Idempotency-Key when provided", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fakeFetch = makeFetch(async (_url, init) => {
      capturedHeaders = init?.headers;
      return {
        status: 200,
        ok: true,
        json: async () => ({ id: "msg-2" }),
        text: async () => "",
      };
    });
    const client = createResendClient({ apiKey: "re_test", fetchImpl: fakeFetch });
    await client.sendEmail({
      from: "from@example.com",
      to: ["to@example.com"],
      subject: "x",
      html: "x",
      text: "x",
      idempotencyKey: "pnip:edition-1",
    });
    expect(capturedHeaders?.["Idempotency-Key"]).toBe("pnip:edition-1");
  });

  it("passes tags through when provided", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fakeFetch = makeFetch(async (_url, init) => {
      capturedBody = JSON.parse(init?.body ?? "{}");
      return {
        status: 200,
        ok: true,
        json: async () => ({ id: "msg-3" }),
        text: async () => "",
      };
    });
    const client = createResendClient({ apiKey: "re_test", fetchImpl: fakeFetch });
    await client.sendEmail({
      from: "f",
      to: ["t"],
      subject: "s",
      html: "h",
      text: "x",
      tags: [{ name: "source", value: "pnip" }],
    });
    expect(capturedBody?.tags).toEqual([{ name: "source", value: "pnip" }]);
  });

  it("returns an ok=false result with status and error body on non-2xx", async () => {
    const fakeFetch = makeFetch(async () => ({
      status: 422,
      ok: false,
      json: async () => ({ message: "Bad", name: "validation_error" }),
      text: async () => JSON.stringify({ message: "Bad" }),
    }));
    const client = createResendClient({ apiKey: "re_test", fetchImpl: fakeFetch });
    const res = await client.sendEmail({
      from: "f",
      to: ["t"],
      subject: "s",
      html: "h",
      text: "x",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(422);
      expect(res.errorBody).toContain("Bad");
    }
  });

  it("returns ok=false when the provider response has no id", async () => {
    const fakeFetch = makeFetch(async () => ({
      status: 200,
      ok: true,
      json: async () => ({}),
      text: async () => "",
    }));
    const client = createResendClient({ apiKey: "re_test", fetchImpl: fakeFetch });
    const res = await client.sendEmail({
      from: "f",
      to: ["t"],
      subject: "s",
      html: "h",
      text: "x",
    });
    expect(res.ok).toBe(false);
  });

  it("returns ok=false with status 0 when fetch throws a network error", async () => {
    const fakeFetch = makeFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const client = createResendClient({ apiKey: "re_test", fetchImpl: fakeFetch });
    const res = await client.sendEmail({
      from: "f",
      to: ["t"],
      subject: "s",
      html: "h",
      text: "x",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(0);
      expect(res.errorBody).toMatch(/ECONNREFUSED|network error/);
    }
  });

  it("honours a custom baseUrl", async () => {
    let url = "";
    const fakeFetch = makeFetch(async (u) => {
      url = u;
      return {
        status: 200,
        ok: true,
        json: async () => ({ id: "msg-x" }),
        text: async () => "",
      };
    });
    const client = createResendClient({
      apiKey: "re_test",
      baseUrl: "https://resend.local/api/",
      fetchImpl: fakeFetch,
    });
    await client.sendEmail({
      from: "f",
      to: ["t"],
      subject: "s",
      html: "h",
      text: "x",
    });
    expect(url).toBe("https://resend.local/api/emails");
  });
});
