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
import { seedE2E } from "./fixtures/seed-e2e";
import { setRunToken } from "./fixtures/run-token";

const schema = process.env.PGSCHEMA
  ? `${process.env.PGSCHEMA}_dev`
  : "compass_dev";

async function ensureResearchCaptureSchema(pool: pg.Pool) {
  const migrationPaths = [
    "prisma/migrations/034_research_capture/migration.sql",
    "prisma/migrations/035_research_agent_scope/migration.sql",
    "prisma/migrations/036_research_capture_hardening/migration.sql",
    "prisma/migrations/037_research_guided_ux/migration.sql",
    "prisma/migrations/038_research_blob_cleanup/migration.sql",
  ];

  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO "${schema}"`);
    for (const relativePath of migrationPaths) {
      const migration = (await fs.readFile(path.resolve(process.cwd(), relativePath), "utf8"))
        .replaceAll("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ")
        .replaceAll("CREATE UNIQUE INDEX ASYNC ", "CREATE UNIQUE INDEX IF NOT EXISTS ")
        .replaceAll("CREATE INDEX ASYNC ", "CREATE INDEX IF NOT EXISTS ");
      await client.query(migration);
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

  // Claim the shared e2e org for this run. The seed is upsert-only, so an
  // overlapping run reuses the same row — stamping it here is what lets
  // teardown tell "my data" from "someone else's live data".
  const runToken = crypto.randomUUID().slice(0, 8);
  setRunToken(runToken);

  const pool = new pg.Pool({ connectionString });
  try {
    await ensureResearchCaptureSchema(pool);
    await seedE2E(pool, runToken);
    console.log(`[e2e globalSetup] Seed complete ✓ (run ${runToken})`);
  } finally {
    await pool.end();
  }
}
