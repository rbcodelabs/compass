import { defineConfig } from "@playwright/test";

// Anonymous public-page flow; no shared DB fixture or browser session is needed.
const baseURL = process.env.EXPLORER_BASE_URL;
if (!baseURL)
  throw new Error(
    "Set EXPLORER_BASE_URL to the verified local server or authorized preview",
  );
export default defineConfig({
  testDir: "./e2e/functional/specs",
  testMatch: "api-explorer.spec.ts",
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL,
    storageState: { cookies: [], origins: [] },
    viewport: { width: 1280, height: 800 },
  },
});
