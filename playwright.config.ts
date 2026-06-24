import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: process.env.DOCS_BASE_URL || "https://compass-git-feat-compass-mvp-rbcodelabs-team.vercel.app",
    extraHTTPHeaders: {
      "x-vercel-protection-bypass": "bRUAfVUcOw3PVvAza4eaZFXPRttko2zW",
    },
  },
  projects: [
    {
      name: "screenshots",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
});
