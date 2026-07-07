export interface ExtractedJson<T> {
  ok: true;
  value: T;
}

export interface ExtractedJsonError {
  ok: false;
  error: string;
}

export function extractJson<T = unknown>(content: string): ExtractedJson<T> | ExtractedJsonError {
  const firstBrace = content.indexOf("{");
  const lastBrace = content.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    return { ok: false, error: "no JSON object found in response" };
  }
  const candidate = content.slice(firstBrace, lastBrace + 1);
  try {
    return { ok: true, value: JSON.parse(candidate) as T };
  } catch (err) {
    return { ok: false, error: `JSON parse failed: ${(err as Error).message}` };
  }
}
