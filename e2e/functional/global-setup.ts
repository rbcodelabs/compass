/**
 * Playwright globalSetup — runs before any functional test.
 * Triggered only when E2E_FUNCTIONAL=1 is set (see playwright.config.ts).
 *
 * Seeds the e2e test org/workspace/user into the compass_dev schema so
 * tests have a stable, isolated starting point.
 */
import path from "path";
import pg from "pg";
import { seedE2E } from "./fixtures/seed-e2e";

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

  const pool = new pg.Pool({ connectionString });
  try {
    await seedE2E(pool);
    console.log("[e2e globalSetup] Seed complete ✓");
  } finally {
    await pool.end();
  }
}
