/**
 * Playwright globalSetup — runs before any functional test.
 * Triggered only when E2E_FUNCTIONAL=1 is set (see playwright.config.ts).
 *
 * Seeds the e2e test org/workspace/user into the compass_dev schema so
 * tests have a stable, isolated starting point.
 */
import pg from "pg";
import { seedE2E } from "./fixtures/seed-e2e";

export default async function globalSetup() {
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
