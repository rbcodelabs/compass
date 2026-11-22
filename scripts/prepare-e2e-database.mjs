import { spawnSync } from "node:child_process";
import pg from "pg";

const E2E_SCHEMA = "compass_dev";
const E2E_SENTINEL = "compass-authenticated-e2e";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const connectionString = process.env.DATABASE_URL;

if (process.env.E2E_ISOLATED_DATABASE !== "1" || !connectionString) {
  throw new Error(
    "Database preparation requires E2E_ISOLATED_DATABASE=1 and DATABASE_URL",
  );
}

const target = new URL(connectionString);
const database = decodeURIComponent(target.pathname.replace(/^\//, ""));
if (!LOCAL_HOSTS.has(target.hostname) || database !== "compass_e2e") {
  throw new Error(
    "Database preparation refuses any target except local compass_e2e",
  );
}
const pool = new pg.Pool({ connectionString });

try {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${E2E_SCHEMA}"`);
  // The sentinel is control metadata, not part of the Prisma application
  // schema. Remove the short-lived E0 prototype location if this script is
  // rerun against a database prepared by an earlier revision.
  await pool.query(`DROP TABLE IF EXISTS "${E2E_SCHEMA}".e2e_database_sentinel`);
} finally {
  await pool.end();
}

const prismaUrl = new URL(connectionString);
prismaUrl.searchParams.set("schema", E2E_SCHEMA);

// --accept-data-loss: this is the disposable, sandboxed e2e fixture database
// (the guard above already refuses any target but local compass_e2e), so a
// destructive diff — e.g. a new UNIQUE constraint added to the Prisma schema
// after this database was first provisioned — is exactly the kind of change
// this script exists to apply, not something to block on. Without this flag,
// `db push` exits 1 and refuses to run at all, which is what was actually
// happening on main as of 2026-09-17: `compass_e2e` predated the unique
// constraint added on `evidence(workspace_id, finding_key)`, so every local
// `pnpm test:e2e:functional` invocation failed here before a single test
// ran, with no code path ever reaching the isolated-database or run-lock
// guards. Never applies to production or preview — those go through
// `lib/migrations/runner.ts`, not this script.
const prisma = spawnSync(
  process.execPath,
  ["node_modules/prisma/build/index.js", "db", "push", "--accept-data-loss"],
  {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: prismaUrl.toString() },
    stdio: "inherit",
  },
);
if (prisma.status !== 0) {
  throw new Error(`prisma db push failed with exit code ${prisma.status ?? "unknown"}`);
}

const sentinelPool = new pg.Pool({ connectionString });
try {
  await sentinelPool.query(`
    CREATE TABLE IF NOT EXISTS public.e2e_database_sentinel (
      value TEXT PRIMARY KEY
    )
  `);
  await sentinelPool.query(
    `INSERT INTO public.e2e_database_sentinel (value)
     VALUES ($1)
     ON CONFLICT (value) DO NOTHING`,
    [E2E_SENTINEL],
  );
} finally {
  await sentinelPool.end();
}

console.log(
  `[e2e db] Prepared ${E2E_SCHEMA} in the dedicated local ${new URL(connectionString).pathname.slice(1)} database`,
);
