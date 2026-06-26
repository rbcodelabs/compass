import { defineConfig, devices } from "@playwright/test";

/**
 * Set E2E_FUNCTIONAL=1 to enable the functional test suite.
 * Without it (e.g., `pnpm test:e2e`), only the screenshots project runs,
 * preserving existing CI behaviour with no local server or DB required.
 */
const functional = !!process.env.E2E_FUNCTIONAL;

export default defineConfig({
  ...(functional && {
    globalSetup: "./e2e/functional/global-setup.ts",
    globalTeardown: "./e2e/functional/global-teardown.ts",
    webServer: {
      command: "pnpm dev",
      port: 3002,
      reuseExistingServer: !process.env.CI,
      env: { PORT: "3002" },
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
      use: { baseURL: "http://localhost:3002" },
    },
    {
      name: "functional",
      testDir: "./e2e/functional/specs",
      use: {
        storageState: "e2e/functional/.auth/user.json",
        baseURL: "http://localhost:3002",
      },
      dependencies: ["functional-setup"],
    },

    // ── Docs screenshots (existing, unchanged) ──────────────────────────────
    // Runs against the Vercel preview URL — no local server needed.
    {
      name: "screenshots",
      testMatch: "e2e/screenshots.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        baseURL:
          process.env.DOCS_BASE_URL ||
          "https://compass-git-feat-compass-mvp-rbcodelabs-team.vercel.app",
        extraHTTPHeaders: {
          "x-vercel-protection-bypass": "bRUAfVUcOw3PVvAza4eaZFXPRttko2zW",
        },
      },
    },
  ],
});
