import { defineConfig, devices } from "@playwright/test";

/**
 * Set E2E_FUNCTIONAL=1 to enable the functional test suite.
 * Without it (e.g., `pnpm test:e2e`), only the screenshots project runs,
 * preserving existing CI behaviour with no local server or DB required.
 */
const functional = !!process.env.E2E_FUNCTIONAL;
// Override with E2E_FUNCTIONAL_PORT when 3002 is already taken locally (e.g.
// another worktree's dev server). Defaults to 3002 for CI and everyone else.
const FUNCTIONAL_PORT = Number(process.env.E2E_FUNCTIONAL_PORT) || 3002;

// This repo runs many worktrees/dev servers in parallel, so the default port
// can collide with an unrelated concurrent worktree's server. Override via
// E2E_PORT (e.g. `E2E_PORT=3033 pnpm test:e2e:functional`) rather than
// editing the checked-in default — same pattern as DOCS_BASE_URL below.
const FUNCTIONAL_PORT = process.env.E2E_PORT
  ? Number(process.env.E2E_PORT)
  : 3002;

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
      use: { baseURL: `http://localhost:${FUNCTIONAL_PORT}` },
    },
    {
      name: "functional",
      testDir: "./e2e/functional/specs",
      use: {
        storageState: "e2e/functional/.auth/user.json",
        baseURL: `http://localhost:${FUNCTIONAL_PORT}`,
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
