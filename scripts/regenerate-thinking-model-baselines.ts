#!/usr/bin/env node
/**
 * Regenerates the two CLASSIC baselines that pin "NULL is literally identical to
 * today" for the thinking-model label conversion, from a checkout of origin/main.
 *
 *   __tests__/thinking-model/classic-text.snapshot.json   rendered text of the harness cases
 *       (via the harness __tests__/thinking-model/classic-text.test.tsx)
 *   __tests__/thinking-model/classic-copy.main.json       every entity-bearing copy
 *       fragment in main's version of each converted file
 *
 * Both are generated from MAIN'S components, never from this branch, which is what
 * makes them evidence. Usage (from this branch's root):
 *
 *   git worktree add --detach ../compass-main-baseline origin/main
 *   (cd ../compass-main-baseline && pnpm install --frozen-lockfile && pnpm exec prisma generate)
 *   node scripts/regenerate-thinking-model-baselines.ts ../compass-main-baseline
 *   git worktree remove --force ../compass-main-baseline
 *
 * Refuses (scripts/thinking-model-baseline-guard.ts) a checkout that contains lib/thinking-model, has local changes, or
 * whose HEAD is not origin/main or an ancestor of it. The harness imports nothing from lib/thinking-model, so it
 * runs unchanged against main's components.
 */
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { CONVERTED_FILES } from "../__tests__/thinking-model/converted-files.ts"
import { entityFragments } from "../__tests__/thinking-model/copy-extract.ts"
import { assertBaselineCheckout } from "./thinking-model-baseline-guard.ts"

const target = process.argv[2]
if (!target) {
  console.error("Usage: node scripts/regenerate-thinking-model-baselines.ts <path-to-origin-main-checkout>")
  process.exit(2)
}
const main = path.resolve(target)
const here = process.cwd()
// Refuses a dirty checkout, the feature branch, or any HEAD that is not origin/main or an ancestor of it.
const sha = assertBaselineCheckout(main)
console.log(`Generating baselines from ${main} at ${sha}`)

// 1. Copy fragments from main's source.
const files: Record<string, string[]> = {}
for (const file of CONVERTED_FILES) {
  const full = path.join(main, file)
  if (existsSync(full)) files[file] = entityFragments(readFileSync(full, "utf-8"), file)
}
writeFileSync(
  path.join(here, "__tests__/thinking-model/classic-copy.main.json"),
  JSON.stringify({ generatedFrom: "origin/main", mainSha: sha, files }, null, 2) + "\n",
)

// 2. Rendered-text snapshot: run the harness inside main's checkout.
const harness = "__tests__/thinking-model/classic-text.test.tsx"
const snapshot = "__tests__/thinking-model/classic-text.snapshot.json"
const harnessDir = path.join(main, path.dirname(harness))
const createdDir = !existsSync(harnessDir)
mkdirSync(harnessDir, { recursive: true })
copyFileSync(path.join(here, harness), path.join(main, harness))
try {
  execFileSync("pnpm", ["exec", "vitest", "run", "--maxWorkers=2", harness], {
    cwd: main,
    stdio: "inherit",
    env: { ...process.env, WRITE_CLASSIC_SNAPSHOT: "1" },
  })
  copyFileSync(path.join(main, snapshot), path.join(here, snapshot))
} finally {
  rmSync(path.join(main, harness), { force: true })
  rmSync(path.join(main, snapshot), { force: true })
  if (createdDir) rmSync(harnessDir, { recursive: true, force: true })
}
console.log("Wrote classic-text.snapshot.json and classic-copy.main.json")
