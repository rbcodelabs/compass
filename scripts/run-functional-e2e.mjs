import { spawnSync } from "node:child_process";
import path from "node:path";

try {
  process.loadEnvFile(path.resolve(process.cwd(), ".env.local"));
} catch {
  // CI supplies DATABASE_URL directly.
}

const mode = process.argv[2];
const passthrough = process.argv.slice(3).filter((argument) => argument !== "--");
const modes = {
  roadmap: [
    "--project=functional-setup",
    "--project=functional",
    "e2e/functional/specs/roadmap-timeline.spec.ts",
    "e2e/functional/specs/roadmap-unscheduled-items.spec.ts",
  ],
  functional: ["--project=functional-setup", "--project=functional"],
  all: [],
};

if (!(mode in modes)) {
  throw new Error("Usage: run-functional-e2e.mjs <roadmap|functional|all>");
}

const env = {
  ...process.env,
  CI: "1",
  E2E_FUNCTIONAL: "1",
  E2E_ISOLATED_DATABASE: "1",
};

function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  });
  return result.status ?? 1;
}

const prepareCode = run(["scripts/prepare-e2e-database.mjs"]);
if (prepareCode !== 0) process.exit(prepareCode);

const playwrightCode = run([
  "node_modules/@playwright/test/cli.js",
  "test",
  ...modes[mode],
  "--retries=0",
  ...passthrough,
]);
const cleanupCode = run(["scripts/verify-e2e-cleanup.mjs"]);

process.exit(playwrightCode !== 0 ? playwrightCode : cleanupCode);
