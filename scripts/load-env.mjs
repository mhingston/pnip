#!/usr/bin/env node
// Helper for bash cron scripts. Loads the project .env via dotenv
// and prints `export KEY=VALUE` lines for every variable, so the
// caller can `eval "$(node scripts/load-env.mjs)"`. Quoting is
// handled by escaping single quotes in the value.
//
// The output is intentionally shell-portable: the only characters
// emitted are letters, digits, underscores, equals, single quotes
// (escaped), and newlines. No backticks, no dollar signs, no
// command-substitution sequences.
//
// Exit codes:
//   0 success
//   1 .env not found

import { config } from "dotenv";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, "..", ".env");

if (!existsSync(envPath)) {
  console.error(`load-env: .env not found at ${envPath}`);
  process.exit(1);
}

const result = config({ path: envPath, quiet: true });
if (result.error) {
  console.error(`load-env: failed to parse .env: ${result.error.message}`);
  process.exit(1);
}

function escape(value) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/'/g, "'\\''");
}

for (const [key, value] of Object.entries(result.parsed ?? {})) {
  if (value === undefined || value === null) continue;
  process.stdout.write(`export ${key}='${escape(value)}'\n`);
}
