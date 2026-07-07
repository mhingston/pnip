/**
 * Thin Resend API client.
 *
 * §46: "Resend is the exclusive email provider." This module is the only
 * place that talks to api.resend.com. It owns the HTTP boundary so the
 * service layer can be unit-tested without network.
 */

export interface ResendEmailInput {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  tags?: { name: string; value: string }[];
  headers?: Record<string, string>;
  idempotencyKey?: string;
}

export interface ResendEmailSuccess {
  ok: true;
  status: number;
  messageId: string;
  raw: unknown;
}

export interface ResendEmailFailure {
  ok: false;
  status: number;
  errorBody: string;
  raw: unknown;
}

export type ResendEmailResult = ResendEmailSuccess | ResendEmailFailure;

export interface ResendClient {
  sendEmail(input: ResendEmailInput): Promise<ResendEmailResult>;
}

export interface FetchLike {
  (input: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{
    status: number;
    ok: boolean;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }>;
}

export interface ResendClientConfig {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export function createResendClient(config: ResendClientConfig): ResendClient {
  if (!config.apiKey || typeof config.apiKey !== "string") {
    throw new Error("ResendClient: apiKey is required");
  }
  const baseUrl = (config.baseUrl ?? "https://api.resend.com").replace(/\/$/, "");
  const fetchImpl = config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

  return {
    async sendEmail(input) {
      const body: Record<string, unknown> = {
        from: input.from,
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
      };
      if (input.tags && input.tags.length > 0) body.tags = input.tags;
      if (input.headers && Object.keys(input.headers).length > 0) {
        body.headers = input.headers;
      }

      const headers: Record<string, string> = {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "pnip-digestive/0.1",
      };
      if (input.idempotencyKey) {
        headers["Idempotency-Key"] = input.idempotencyKey;
      }

      const url = `${baseUrl}/emails`;
      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          status: 0,
          errorBody: `network error: ${msg}`,
          raw: null,
        };
      }

      let raw: unknown = null;
      try {
        raw = await response.json();
      } catch {
        try {
          raw = await response.text();
        } catch {
          raw = null;
        }
      }

      const messageId =
        raw && typeof raw === "object" && "id" in raw
          ? String((raw as { id: unknown }).id)
          : null;

      if (response.ok) {
        if (!messageId) {
          return {
            ok: false,
            status: response.status,
            errorBody: "provider response missing id",
            raw,
          };
        }
        return {
          ok: true,
          status: response.status,
          messageId,
          raw,
        };
      }

      const textBody =
        typeof raw === "string"
          ? raw
          : raw && typeof raw === "object"
            ? JSON.stringify(raw)
            : "";
      return {
        ok: false,
        status: response.status,
        errorBody: textBody || response.status.toString(),
        raw,
      };
    },
  };
}
