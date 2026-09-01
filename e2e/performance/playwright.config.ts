import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { assertSafeAuthState } from "../../lib/performance-baseline";

if (process.env.COMPASS_PERF_BASELINE !== "1") {
  throw new Error("Set COMPASS_PERF_BASELINE=1 to run the opt-in baseline");
}
const baseURL = process.env.PERF_BASE_URL;
if (!baseURL) throw new Error("PERF_BASE_URL is required");
const storageState = process.env.PERF_STORAGE_STATE;
if (!storageState || (process.env.PERF_SERVER_KIND !== "local-production" && !fs.existsSync(storageState))) {
  throw new Error("PERF_STORAGE_STATE must name an existing ignored auth-state file");
}
if (fs.existsSync(storageState)) assertSafeAuthState(storageState);
const headSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const buildSha = process.env.PERF_BUILD_SHA;
const expectedSha = process.env.PERF_EXPECTED_SHA;
if (!buildSha || !expectedSha || buildSha !== expectedSha || buildSha !== headSha) {
  throw new Error("PERF_BUILD_SHA does not match PERF_EXPECTED_SHA");
}
if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) {
  throw new Error("Performance baselines require a clean committed worktree");
}
if (!["local-production", "vercel-preview"].includes(process.env.PERF_SERVER_KIND ?? "")) {
  throw new Error("PERF_SERVER_KIND must be local-production or vercel-preview");
}
if (process.env.PERF_SERVER_KIND === "local-production" && process.env.PERF_EXTERNALLY_MANAGED !== "1") {
  throw new Error("local-production baselines require performance:run-local");
}

export default defineConfig({
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  testDir: ".",
  testMatch: "performance-baseline.spec.ts",
  outputDir: "../../test-results/performance-baseline",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    baseURL,
    storageState,
    trace: "retain-on-failure",
    ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET && {
      extraHTTPHeaders: {
        "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
      },
    }),
  },
});
