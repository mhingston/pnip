import type { Kysely } from "kysely";
import type { Database } from "../database/kysely.js";
import {
  getPartitionMetrics,
  type PartitionMetricEntry,
  type PartitionMetricDayEntry,
} from "../editions/edition-metrics.js";

export interface PartitionsCommandDeps {
  db: Kysely<Database>;
  log?: (msg: string) => void;
}

export interface PartitionsCommandResult {
  exitCode: number;
}

export interface ParsePartitionsFlagsInput {
  args: string[];
}

export interface ParsedPartitionsFlags {
  help: boolean;
  errors: string[];
}

export function parsePartitionsFlags(
  input: ParsePartitionsFlagsInput,
): ParsedPartitionsFlags {
  const errors: string[] = [];
  let help = false;
  for (const a of input.args) {
    switch (a) {
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        errors.push(`unknown flag: ${a}`);
    }
  }
  return { help, errors };
}

function padEnd(s: string, w: number): string {
  if (s.length >= w) return s;
  return s + " ".repeat(w - s.length);
}

function colWidth(header: string, values: string[]): number {
  let w = header.length;
  for (const v of values) {
    if (v.length > w) w = v.length;
  }
  return w;
}

function renderTable(
  headers: string[],
  rows: string[][],
): string[] {
  const widths = headers.map((h, i) =>
    colWidth(h, rows.map((r) => r[i] ?? "")),
  );
  const lines: string[] = [];
  let headerLine = "";
  for (let i = 0; i < headers.length; i++) {
    headerLine += padEnd(headers[i]!, widths[i]!);
    if (i < headers.length - 1) headerLine += "  ";
  }
  lines.push(headerLine);
  for (const r of rows) {
    let line = "";
    for (let i = 0; i < headers.length; i++) {
      line += padEnd(r[i] ?? "", widths[i]!);
      if (i < headers.length - 1) line += "  ";
    }
    lines.push(line);
  }
  return lines;
}

function renderPartitionsTable(
  entries: PartitionMetricEntry[],
): string[] {
  const headers = ["partition", "total_docs", "days", "latest_date", "latest_count"];
  const rows = entries.map((e) => [
    e.partition_key,
    String(e.total_documents),
    String(e.distinct_days),
    e.latest_edition_date ?? "null",
    String(e.latest_document_count),
  ]);
  return renderTable(headers, rows);
}

function renderPerDayBreakdown(
  entries: PartitionMetricDayEntry[],
): string[] {
  const byDay = new Map<string, PartitionMetricDayEntry[]>();
  for (const e of entries) {
    const list = byDay.get(e.edition_date);
    if (list) list.push(e);
    else byDay.set(e.edition_date, [e]);
  }
  const dates = Array.from(byDay.keys()).sort((a, b) => (a < b ? 1 : -1));
  const lines: string[] = [];
  for (const date of dates) {
    const parts = (byDay.get(date) ?? [])
      .slice()
      .sort((a, b) => a.partition_key.localeCompare(b.partition_key))
      .map((p) => `${p.partition_key}=${p.document_count}`);
    lines.push(`  ${date}  ${parts.join(" ")}`);
  }
  return lines;
}

export async function runPartitionsCommand(
  deps: PartitionsCommandDeps,
): Promise<PartitionsCommandResult> {
  const log = deps.log ?? ((m: string) => console.log(m));

  let metrics;
  try {
    metrics = await getPartitionMetrics(deps.db);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`partitions: query failed: ${msg}`);
    return { exitCode: 1 };
  }

  const totalDocs = metrics.byPartition.reduce(
    (sum, e) => sum + e.total_documents,
    0,
  );
  log(
    `partitions: ${metrics.byPartition.length} total partitions, ${totalDocs} total documents across all editions`,
  );

  if (metrics.byPartition.length === 0) {
    log("(no partitions — no documents in any edition yet)");
  } else {
    for (const line of renderPartitionsTable(metrics.byPartition)) {
      log(line);
    }
  }

  log("last 7 days (date, partition → count):");
  const dayLines = renderPerDayBreakdown(metrics.perDayLast7Days);
  if (dayLines.length === 0) {
    log("  (no editions in the last 7 days)");
  } else {
    for (const line of dayLines) {
      log(line);
    }
  }

  return { exitCode: 0 };
}

export const PARTITIONS_HELP = `digestive partitions — §11 read-only per-partition observability

Reports how many documents live in each partition_key (computed from
documents joined to editions), how many distinct edition dates each
partition has produced, the most recent edition date with documents in
each partition, and a per-day breakdown of document counts for the last
seven days. No rows are written.

Usage:
  digestive partitions [flags]

Flags:
  -h, --help    show this help

Exit codes:
  0   metrics gathered and logged
  1   query failed
  2   invalid flags / unknown args
`;