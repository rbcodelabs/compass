import { defineConfig, devices } from "@playwright/test";
import crypto from "node:crypto";

/**
 * Set E2E_FUNCTIONAL=1 to enable the functional test suite.
 * Without it (e.g., `pnpm test:e2e`), only the screenshots project runs,
 * preserving existing CI behaviour with no local server or DB required.
 */
const functional = !!process.env.E2E_FUNCTIONAL;

/**
 * Port for the functional suite's `pnpm dev` webServer.
 *
 * This used to be a hardcoded 3002. That's a real hazard in a repo that runs
 * many concurrent git worktrees (see pr-guidelines.md): locally,
 * `reuseExistingServer: !process.env.CI` is true, so if *any* process is
 * already listening on 3002 — most commonly another worktree's own
 * `pnpm dev` — Playwright silently attaches to that unrelated server
 * instead of starting its own. Tests then run against a different
 * worktree's code (and potentially a stale/incompatible build), producing
 * failures that have nothing to do with the change under test. This was
 * confirmed while investigating a "functional suite fails broadly" report:
 * one run surfaced a `Module not found: Can't resolve '@/auth'` Build Error
 * that belonged entirely to a different worktree's checkout.
 *
 * Deriving the port from a hash of the worktree path keeps it stable across
 * repeated runs in the *same* worktree (so `reuseExistingServer` still gets
 * its intended fast-reuse benefit locally) while giving concurrent
 * worktrees distinct ports so they can never collide. Range 4100-4899 is
 * chosen to stay clear of the 3000-3099 range used by this project's
 * `nextdev` worktree dev-server manager.
 */
function functionalPort(): number {
  const hash = crypto.createHash("md5").update(process.cwd()).digest();
  return 4100 + (hash.readUInt16BE(0) % 800);
}

const FUNCTIONAL_PORT = functional ? functionalPort() : 3002;
const FUNCTIONAL_BASE_URL = `http://localhost:${FUNCTIONAL_PORT}`;

export default defineConfig({
  // 90-second per-test timeout for functional specs — server actions + router
  // revalidation in Next.js dev mode can be slow.  Screenshots tests are
  // page-load-only and finish in a few seconds so this is fine for both.
  timeout: 90_000,

  ...(functional && {
    globalSetup: "./e2e/functional/global-setup.ts",
    globalTeardown: "./e2e/functional/global-teardown.ts",
    webServer: {
      command: "pnpm dev",
      port: FUNCTIONAL_PORT,
      reuseExistingServer: !process.env.CI,
      env: { PORT: String(FUNCTIONAL_PORT) },
      timeout: 120_000,
    },
  }),

  projects: [
    // ── Functional suite ────────────────────────────────────────────────────
    // Auth setup runs first (depends: functional-setup), then specs.
    // Requires E2E_FUNCTIONAL=1 to activate webServer + globalSetup.
    {
      name: "functional-setup",
      testMatch: "e2e/functional/auth.setup.ts",
      use: { baseURL: FUNCTIONAL_BASE_URL },
    },
    {
      name: "functional",
      testDir: "./e2e/functional/specs",
      use: {
        storageState: "e2e/functional/.auth/user.json",
        baseURL: FUNCTIONAL_BASE_URL,
      },
      dependencies: ["functional-setup"],
    },

    // ── Docs screenshots ─────────────────────────────────────────────────────
    // No local server needed — this hits an already-deployed URL. Defaults to
    // production, which holds the curated demo org (rb-code-labs/helios) that
    // e2e/screenshots.spec.ts's hardcoded page list expects; a fresh local
    // dev DB or a random preview deployment won't have that workspace.
    //
    // The previous default pointed at a long-merged feature branch's preview
    // deployment, which no longer resolves — `pnpm test:e2e` would hang for
    // ~20 minutes and then fail with no useful output. Override via
    // DOCS_BASE_URL to point at a preview deployment instead (the bypass
    // secret below is registered at the project level, so it works across
    // every branch's preview, not just the one it was first added for).
    {
      name: "screenshots",
      testMatch: "e2e/screenshots.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        baseURL: process.env.DOCS_BASE_URL || "https://compass.rbcodelabs.com",
        extraHTTPHeaders: {
          "x-vercel-protection-bypass": "bRUAfVUcOw3PVvAza4eaZFXPRttko2zW",
        },
      },
    },
  ],
});
