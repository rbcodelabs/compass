import { spawnSync } from "node:child_process";
import path from "node:path";
import { withE2ERunLock } from "./e2e-run-lock.mjs";

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
    "e2e/functional/specs/native-timeline-rollout.spec.ts",
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

// The whole prepare → test → cleanup sequence mutates one shared, fixed
// fixture (org slug e2e-test-org) in the shared local compass_e2e database.
// Two concurrent invocations of this script — from two worktrees, two agent
// sessions, or a human and an agent — corrupt each other's runs: both seed
// into the same rows, and `prisma db push` isn't safe to race against
// itself. Holding one Postgres advisory lock for the full sequence makes a
// second concurrent invocation wait its turn instead of silently colliding.
// See scripts/e2e-run-lock.mjs for the reproduction that motivated this.
const exitCode = await withE2ERunLock(env, async () => {
  const prepareCode = run(["scripts/prepare-e2e-database.mjs"]);
  if (prepareCode !== 0) return prepareCode;

  const playwrightCode = run([
    "node_modules/@playwright/test/cli.js",
    "test",
    ...modes[mode],
    "--retries=0",
    ...passthrough,
  ]);
  const cleanupCode = run(["scripts/verify-e2e-cleanup.mjs"]);

  return playwrightCode !== 0 ? playwrightCode : cleanupCode;
});

process.exit(exitCode);
