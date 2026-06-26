import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: BASE_URL,
    extraHTTPHeaders: {
      "x-vercel-protection-bypass": process.env.VERCEL_BYPASS_TOKEN ?? "bRUAfVUcOw3PVvAza4eaZFXPRttko2zW",
    },
  },
  projects: [
    // Auth setup runs first and saves session to e2e/.auth/user.json
    {
      name: "auth-setup",
      testMatch: /auth\.setup\.ts/,
    },
    // Main E2E suite — uses the saved auth session
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "e2e/.auth/user.json",
      },
      dependencies: ["auth-setup"],
      testIgnore: /auth\.setup\.ts/,
    },
    // Mobile viewport — uses the same auth session
    {
      name: "mobile",
      use: {
        ...devices["iPhone 14"],
        storageState: "e2e/.auth/user.json",
      },
      dependencies: ["auth-setup"],
      testIgnore: /auth\.setup\.ts/,
    },
    // Screenshot project (existing) — no auth dependency, no storageState
    {
      name: "screenshots",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
      testMatch: /screenshots\.spec\.ts/,
    },
  ],
});
