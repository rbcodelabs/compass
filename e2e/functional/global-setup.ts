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
    "prisma/migrations/043_decision_evidence_refs/migration.sql",
    "prisma/migrations/044_now_policy_application_evidence/migration.sql",
    "prisma/migrations/045_now_gate_shadow_evaluations/migration.sql",
    "prisma/migrations/046_shared_comments/migration.sql",
    "prisma/migrations/050_pm_interviews/migration.sql",
    "prisma/migrations/061_product_analytics/migration.sql",
    "prisma/migrations/063_metrics_dashboard/migration.sql",
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
        const constraint = statement.match(/ALTER\s+TABLE\s+"([^"]+)"\s+ADD\s+CONSTRAINT\s+"([^"]+)"/i);
        if (constraint) {
          const existing = await client.query<{ exists: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname=$2 AND c.conname=$3) AS exists",
            [schema, constraint[1], constraint[2]],
          );
          if (existing.rows[0]?.exists) continue;
        }
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
    await seedE2E(pool, runToken);
    console.log(`[e2e globalSetup] Seed complete ✓ (run ${runToken})`);
  } finally {
    await pool.end();
  }
}
