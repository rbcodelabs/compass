#!/usr/bin/env node
// Helper for the "Integration tests" CI job (.github/workflows/integration-tests.yml).
//
//   node scripts/integration-tests.mjs list          print every test file that opts in via helpers/integration-database
//   node scripts/integration-tests.mjs check <json>  verify a `vitest --reporter=json` result actually ran them
//
// `check` exists so the job can never go green by skipping everything: INTEGRATION_TEST_DATABASE_URL unset or
// misspelled makes every suite skip cleanly, which vitest reports as success. Every listed file must have at least one
// passed test and none failed.
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const MARKER = "helpers/integration-database"
const root = process.cwd()

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "helpers" ? [] : walk(full)
    return /\.test\.tsx?$/.test(entry.name) ? [full] : []
  })
}

export function listIntegrationTests() {
  return walk(path.join(root, "__tests__"))
    .filter((file) => readFileSync(file, "utf8").includes(MARKER))
    .map((file) => path.relative(root, file))
    .sort()
}

function check(jsonPath) {
  const report = JSON.parse(readFileSync(jsonPath, "utf8"))
  const byFile = new Map(report.testResults.map((r) => [path.relative(root, r.name), Object.assign(r.assertionResults ?? [], { suiteFailed: r.status === "failed" })]))
  const problems = []
  let passedTotal = 0
  for (const file of listIntegrationTests()) {
    const tests = byFile.get(file)
    if (!tests) { problems.push(`${file}: not in the vitest report`); continue }
    const count = (status) => tests.filter((t) => t.status === status).length
    const [passed, failed, skipped] = [count("passed"), count("failed"), count("skipped") + count("pending") + count("todo")]
    passedTotal += passed
    console.log(`${failed ? "FAIL" : passed ? "ok  " : "SKIP"} ${file}  passed=${passed} failed=${failed} skipped=${skipped}`)
    if (tests.suiteFailed && !failed) problems.push(`${file}: suite failed to set up or tear down (beforeAll/afterAll error)`)
    else if (failed) problems.push(`${file}: ${failed} failed`)
    else if (passed === 0) problems.push(`${file}: nothing ran (all ${skipped} skipped) - is INTEGRATION_TEST_DATABASE_URL set?`)
  }
  console.log(`total passed integration tests: ${passedTotal}`)
  if (passedTotal === 0) problems.push("zero integration tests ran")
  if (problems.length) {
    console.error(`\n${problems.length} problem(s):\n- ${problems.join("\n- ")}`)
    process.exit(1)
  }
}

const [command, arg] = process.argv.slice(2)
if (command === "list") console.log(listIntegrationTests().join("\n"))
else if (command === "check" && arg) check(arg)
else { console.error("usage: integration-tests.mjs list | check <vitest-json>"); process.exit(2) }
