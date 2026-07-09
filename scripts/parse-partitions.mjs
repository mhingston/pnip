#!/usr/bin/env node
// Helper for scripts/daily-publish.sh. Reads PARTITION_CONFIG from the
// environment and prints one line per partition the publication sequence
// should generate a notebook for. The format is "<partition_key>" or
// "<partition_key>:with_podcast" when the operator has enabled the per-
// partition podcast. Master is always emitted and always gets a podcast.
//
// Exit codes:
//   0 success
//   2 invalid PARTITION_CONFIG JSON
//
// The script never prints to stderr on success; only the first JSON
// parse error is reported. The bash caller treats non-zero exit as
// fatal.

const raw = process.env.PARTITION_CONFIG ?? "";

let entries = {};
if (raw.trim() !== "") {
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error("PARTITION_CONFIG must be a JSON object");
      process.exit(2);
    }
    entries = parsed;
  } catch (err) {
    console.error(`Invalid PARTITION_CONFIG: ${err.message}`);
    process.exit(2);
  }
}

const out = ["master:with_podcast"];

for (const [key, value] of Object.entries(entries)) {
  if (!value || typeof value !== "object") continue;
  if (value.enabled === false) continue;
  const tag = value.with_podcast === true ? ":with_podcast" : "";
  out.push(`${key}${tag}`);
}

process.stdout.write(out.join("\n") + "\n");
