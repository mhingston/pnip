// scripts/archive-orphan-jobs.mjs
//
// One-off cleanup: archive pending processing_jobs whose job_type has no
// registered worker. These are leftovers from removed pipelines (the
// legacy embedding/clustering pipeline removed in e28b5cd/a096e30) and
// would otherwise sit in the pending queue forever.
//
// Usage:
//   node scripts/archive-orphan-jobs.mjs [--dry-run]
//
// Idempotent: rerunning is a no-op once the rows are archived.

import { config } from "dotenv";
config({ path: new URL("../.env", import.meta.url).pathname, quiet: true });
import pg from "pg";

const dryRun = process.argv.includes("--dry-run");

const ORPHAN_JOB_TYPES = ["embed_chunk", "cluster_stories"];

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const before = await c.query(
  `SELECT job_type, status, COUNT(*)::int AS count
   FROM processing_jobs
   WHERE job_type = ANY($1) AND status <> 'archived'
   GROUP BY job_type, status
   ORDER BY job_type, status`,
  [ORPHAN_JOB_TYPES],
);
console.log("rows to archive by type/status:");
console.table(before.rows);

if (dryRun) {
  console.log("dry-run; no changes made");
  await c.end();
  process.exit(0);
}

const archived = await c.query(
  `UPDATE processing_jobs
   SET status = 'archived', updated_at = now()
   WHERE job_type = ANY($1) AND status <> 'archived'
   RETURNING id`,
  [ORPHAN_JOB_TYPES],
);
console.log(`archived ${archived.rows.length} orphan job(s)`);

await c.end();
