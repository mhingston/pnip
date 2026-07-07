import type { Config } from "../config/index.js";
import type { PgPool } from "../database/pool.js";
import { getAppliedMigrations, listMigrationFiles } from "../database/migrations.js";
import type { MinifluxClient } from "../discovery/miniflux-client.js";
import type { NotebookLmClient } from "../digest/notebooklm/notebooklm-client.js";
import type { ProcessingJobQueue } from "../jobs/queue/processing-job-queue.js";
import type { ResendClient } from "../digest/html/resend-client.js";
import { buildPluginRegistry } from "./process-registry.js";

export interface DoctorCheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheckResult[];
}

export interface DoctorCommandDeps {
  config: Config;
  pool: PgPool;
  queue: ProcessingJobQueue;
  miniflux?: MinifluxClient;
  resend?: ResendClient;
  notebookLm?: NotebookLmClient;
  resendApiKey?: string;
  migrationsDir?: string;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

const FAILED_THRESHOLD = 100;
const DEFAULT_MIGRATIONS_DIR = "src/database/migrations";
const KNOWN_WORKERS = [
  "expand_document",
  "chunk_document",
  "summarize_chunk",
  "extract_entities",
  "assign_topics",
  "classify_quality",
  "embed_chunk",
  "cluster_stories",
  "summarize_story",
];

interface ProbeResult {
  ok: boolean;
  status: number;
  body?: string;
}

async function probeResend(
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<ProbeResult> {
  const url = "https://api.resend.com/domains";
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      body: text.length > 200 ? text.slice(0, 200) : text,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, body: msg };
  }
}

export async function runDoctorCommand(
  deps: DoctorCommandDeps,
): Promise<{ exitCode: number; report: DoctorReport }> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const checks: DoctorCheckResult[] = [];

  const dbUrl = deps.config.DATABASE_URL;
  checks.push({
    name: "config",
    ok: !!dbUrl && dbUrl.startsWith("postgres"),
    detail: `DATABASE_URL=${dbUrl ? "present" : "missing"}`,
  });

  try {
    await deps.pool.query("SELECT 1");
    checks.push({ name: "postgres", ok: true, detail: "SELECT 1 ok" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({ name: "postgres", ok: false, detail: `SELECT 1 failed: ${msg}` });
  }

  try {
    const applied = await getAppliedMigrations(deps.pool);
    const appliedSet = new Set(applied);
    const onDisk = await listMigrationFiles(
      deps.migrationsDir ?? DEFAULT_MIGRATIONS_DIR,
    );
    const missing = onDisk.filter((f) => !appliedSet.has(f));
    checks.push({
      name: "migrations",
      ok: missing.length === 0,
      detail:
        missing.length === 0
          ? `${applied.length}/${onDisk.length} applied`
          : `${applied.length}/${onDisk.length} applied; missing: ${missing.join(", ")}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({ name: "migrations", ok: false, detail: `failed: ${msg}` });
  }

  try {
    const counts = await deps.queue.countByStatus();
    const failed = counts.failed ?? 0;
    const detail = Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    checks.push({
      name: "queue",
      ok: failed <= FAILED_THRESHOLD,
      detail: `${detail} (failed threshold=${FAILED_THRESHOLD})`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({ name: "queue", ok: false, detail: `countByStatus failed: ${msg}` });
  }

  if (deps.miniflux) {
    try {
      const h = await deps.miniflux.health();
      checks.push({
        name: "miniflux",
        ok: h.ok,
        detail: `status=${h.status}${h.body ? ` body=${h.body}` : ""}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      checks.push({ name: "miniflux", ok: false, detail: `failed: ${msg}` });
    }
  } else {
    checks.push({
      name: "miniflux",
      ok: true,
      detail: "skipped (MINIFLUX_URL not set)",
    });
  }

  if (deps.resendApiKey) {
    const f = deps.fetchImpl ?? globalThis.fetch;
    const h = await probeResend(deps.resendApiKey, f);
    checks.push({
      name: "resend",
      ok: h.ok,
      detail: `status=${h.status}${h.body ? ` body=${h.body}` : ""}`,
    });
  } else {
    checks.push({
      name: "resend",
      ok: true,
      detail: "skipped (RESEND_API_KEY not set)",
    });
  }

  if (deps.notebookLm) {
    try {
      const h = await deps.notebookLm.authCheck();
      checks.push({
        name: "notebooklm",
        ok: h.ok,
        detail: h.ok ? "auth check ok" : "auth check failed",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      checks.push({ name: "notebooklm", ok: false, detail: `failed: ${msg}` });
    }
  } else {
    checks.push({
      name: "notebooklm",
      ok: true,
      detail: "skipped (notebooklm not configured)",
    });
  }

  try {
    const registry = buildPluginRegistry();
    const registered = registry.list().map((p) => p.name);
    const detail = `workers: known=${KNOWN_WORKERS.length}; ` +
      `registered=${registered.length}; ` +
      `known=[${KNOWN_WORKERS.join(", ")}]; ` +
      `registered=[${registered.join(", ")}]`;
    checks.push({ name: "workers", ok: true, detail });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({ name: "workers", ok: false, detail: `failed: ${msg}` });
  }

  for (const c of checks) {
    log(`${c.ok ? "ok" : "fail"}: ${c.name}: ${c.detail}`);
  }
  const okCount = checks.filter((c) => c.ok).length;
  log(`summary: ${okCount}/${checks.length} checks ok`);
  const report: DoctorReport = {
    ok: okCount === checks.length,
    checks,
  };
  return { exitCode: report.ok ? 0 : 1, report };
}

export const DOCTOR_HELP = `digestive doctor — diagnostics for PostgreSQL, migrations, queues, and external APIs

Runs a set of health checks against the live configuration and exits 0 only
when every check passes. Each check is logged on its own line and a final
summary reports the pass count.

Checks (in order):
  config         DATABASE_URL starts with 'postgres'
  postgres       SELECT 1 against the pool
  migrations     every on-disk migration file is in the _migrations table
  queue          countByStatus() snapshot; fails when failed > 100
  miniflux       /v1/me with X-Auth-Token (skipped if MINIFLUX_URL unset)
  resend         GET /domains with the configured API key
                 (skipped if RESEND_API_KEY unset)
  notebooklm     authCheck via the notebooklm-py CLI
                 (skipped if notebooklm client not configured)
  workers        buildPluginRegistry() succeeds; lists known worker names

Usage:
  digestive doctor [flags]

Flags:
  -h, --help    show this help

Exit codes:
  0   all checks passed
  1   one or more checks failed

Optional integrations (miniflux, resend, notebooklm) report ok=true with
detail="skipped (...)" when the corresponding config is absent, so doctor
only fails on actual problems, not on operator-deferred integrations.
`;