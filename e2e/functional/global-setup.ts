/**
 * Playwright globalSetup — runs before any functional test.
 * Triggered only when E2E_FUNCTIONAL=1 is set (see playwright.config.ts).
 *
 * Seeds the e2e test org/workspace/user into the compass_dev schema so
 * tests have a stable, isolated starting point.
 */
import path from "path";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import pg from "pg";
import { backfillRoadmapCommitmentProvenance } from "../../lib/dsql-backfill";
import { seedE2E } from "./fixtures/seed-e2e";
import { setRunToken } from "./fixtures/run-token";
import { assertIsolatedE2EDatabase } from "./fixtures/isolated-database";

const schema = process.env.PGSCHEMA
  ? `${process.env.PGSCHEMA}_dev`
  : "compass_dev";

async function ensureFunctionalSchema(pool: pg.Pool) {
  const migrationPaths = [
    "prisma/migrations/028_agent_runtime_config/migration.sql",
    "prisma/migrations/034_research_capture/migration.sql",
    "prisma/migrations/035_research_agent_scope/migration.sql",
    "prisma/migrations/036_research_capture_hardening/migration.sql",
    "prisma/migrations/037_research_guided_ux/migration.sql",
    "prisma/migrations/038_research_blob_cleanup/migration.sql",
    "prisma/migrations/039_native_decision_gates/migration.sql",
    "prisma/migrations/040_release_authorization/migration.sql",
    "prisma/migrations/041_portfolio_capacity_ledger/migration.sql",
  ];

  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO "${schema}"`);
    for (const relativePath of migrationPaths) {
      const migration = (await fs.readFile(path.resolve(process.cwd(), relativePath), "utf8"))
        .replace(/CREATE TABLE (?!IF NOT EXISTS )/g, "CREATE TABLE IF NOT EXISTS ")
        .replaceAll("CREATE UNIQUE INDEX ASYNC IF NOT EXISTS ", "CREATE UNIQUE INDEX IF NOT EXISTS ")
        .replaceAll("CREATE INDEX ASYNC IF NOT EXISTS ", "CREATE INDEX IF NOT EXISTS ")
        .replaceAll("CREATE UNIQUE INDEX ASYNC ", "CREATE UNIQUE INDEX IF NOT EXISTS ")
        .replaceAll("CREATE INDEX ASYNC ", "CREATE INDEX IF NOT EXISTS ")
        .replaceAll("ALTER TABLE ASYNC ", "ALTER TABLE ");
      if (!relativePath.includes("039_native_decision_gates")) {
        await client.query(migration);
        continue;
      }
      const statements = migration
        .split(/;\s*\n/)
        .map((statement) => statement.trim())
        .filter(Boolean)
        .map((statement) => (statement.endsWith(";") ? statement : `${statement};`));
      let pendingProvenanceBackfill = false;
      for (const statement of statements) {
        await client.query(statement);
        if (/ALTER\s+COLUMN\s+"?now_commitment_provenance"?\s+SET\s+DEFAULT/i.test(statement)) {
          pendingProvenanceBackfill = true;
        } else if (pendingProvenanceBackfill && /^COMMIT;?$/i.test(statement)) {
          pendingProvenanceBackfill = false;
          await backfillRoadmapCommitmentProvenance(client, schema, []);
        }
      }
    }
  } finally {
    client.release();
  }
}

export default async function globalSetup() {
  // Load .env.local so DATABASE_URL is available to globalSetup
  // (Playwright runs this in a separate process before Next.js starts)
  try {
    process.loadEnvFile(path.resolve(process.cwd(), ".env.local"));
  } catch {
    // .env.local may not exist in CI — continue; DATABASE_URL should be set externally
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "[e2e globalSetup] DATABASE_URL is not set. " +
        "Copy .env.local from the repo root into this worktree."
    );
  }

  // Every functional run mutates a fixed fixture workspace. Refuse to seed
  // until the target is the explicitly prepared, local-only E2E database.
  await assertIsolatedE2EDatabase();

  // Claim the shared e2e org for this run. The seed is upsert-only, so an
  // overlapping run reuses the same row — stamping it here is what lets
  // teardown tell "my data" from "someone else's live data".
  const runToken = crypto.randomUUID().slice(0, 8);
  setRunToken(runToken);

  const pool = new pg.Pool({ connectionString });
  try {
    await ensureFunctionalSchema(pool);
    const seed = await seedE2E(pool, runToken);
    const policyPath = path.resolve(process.cwd(), "test-results/e2e-now-commitment-policy.json");
    await fs.mkdir(path.dirname(policyPath), { recursive: true });
    await fs.writeFile(policyPath, `${JSON.stringify(seed.nowCommitmentPolicy, null, 2)}\n`, "utf8");
    console.log(`[e2e globalSetup] Seed complete ✓ (run ${runToken})`);
  } finally {
    await pool.end();
  }
}
