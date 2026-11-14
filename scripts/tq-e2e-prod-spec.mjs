#!/usr/bin/env node
/**
 * Generates the `tq submit --profile custom --spec FILE` spec that runs the Compass functional e2e suite against the
 * production build with mock auth (E2E_SERVER=prod, see playwright.config.ts and lib/e2e-harness.ts).
 *
 *   node scripts/tq-e2e-prod-spec.mjs [--spec e2e/functional/specs/a.spec.ts ...] [--unflagged-assert] [--control] [--out spec.json]
 *   tq submit --repo rbcodelabs/compass --sha <pushed 40-hex> --profile custom --spec spec.json --timeout 45m --json
 *
 * Steps: install, playwright-browsers, create-e2e-db, [build-unflagged-assert], build, assert, e2e.
 *   --unflagged-assert  first builds WITHOUT the flag with `pnpm build` (which runs scripts/assert-no-mock-auth.mjs and fails on a
 *                       leak), then discards it. This is the same command Vercel runs.
 *   --control           e2e on the default dev server instead of the prod build (same SHA, same worker: the comparison control).
 * Never edit tq workers, and never run this from the Mac: the steps are heavy.
 */
import fs from "node:fs"
import { pathToFileURL } from "node:url"

const ENV = {
  NEXT_TELEMETRY_DISABLED: "1",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  PLAYWRIGHT_BROWSERS_PATH: "/var/lib/testq/home/.cache/ms-playwright",
  AUTH_SECRET: "testq-throwaway-e2e-auth-secret-not-a-secret",
}

const COUNT_FAKES = `for s in 'compass-e2e-mock-auth-v1' 'e2e-no-provider' 'Test analysis: participant described' 'x-e2e-pm-fail-receipt-finalization'; do
  echo "$s: non-map files=$(find .next/server .next/static -type f ! -name '*.map' -print0 | xargs -0 grep -l -- "$s" | wc -l)"
done`

/**
 * @param {{ specs?: string[], unflaggedAssert?: boolean, control?: boolean, e2eEnv?: string }} [options]
 * @returns {{ reserve_mb: number, timeout_s: number, database: boolean, node: string, env: Record<string, string>, steps: { name: string, run: string }[], artifacts: string[] }}
 */
export function buildTqSpec({ specs = [], unflaggedAssert = false, control = false, e2eEnv = "" } = {}) {
  const specArgs = specs.length > 0 ? ` -- ${specs.join(" ")}` : ""
  const e2eServer = control ? "" : "E2E_SERVER=prod "
  const steps = [
    { name: "install", run: "corepack pnpm install --frozen-lockfile" },
    { name: "playwright-browsers", run: "corepack pnpm exec playwright install chromium" },
    { name: "create-e2e-db", run: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c 'create database compass_e2e'` },
  ]
  if (!control) {
    if (unflaggedAssert) {
      steps.push({
        name: "build-unflagged-assert",
        // The default build command, exactly as Vercel runs it: it ends with scripts/assert-no-mock-auth.mjs and fails on a leak.
        run: `export CI=1\ncorepack pnpm build\necho UNFLAGGED artifact:\n${COUNT_FAKES}\nrm -rf .next`,
      })
    }
    steps.push(
      { name: "build", run: "export CI=1\n/usr/bin/time -v corepack pnpm build:e2e" },
      {
        name: "assert",
        // The flagged artifact must contain the marker; otherwise the unflagged assert above would prove nothing.
        run: `test -f .next/BUILD_ID
n=$(find .next/server .next/static -type f ! -name '*.map' -print0 | xargs -0 grep -l 'compass-e2e-mock-auth-v1' | wc -l)
echo "flagged artifact: marker in $n deployable files"
${COUNT_FAKES}
test "$n" -gt 0`,
      },
    )
  }
  steps.push({
    name: "e2e",
    run: `export DATABASE_URL="\${DATABASE_URL%/*}/compass_e2e"
mkdir -p diag
${e2eEnv ? `export ${e2eEnv}\n` : ""}${e2eServer}corepack pnpm run test:e2e:functional${specArgs}`,
  })
  return { reserve_mb: 8192, timeout_s: 2700, database: true, node: "22", env: ENV, steps, artifacts: ["test-results", "playwright-report"] }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2)
  const specs = []
  let out
  let e2eEnv = ""
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--spec") specs.push(args[++index])
    else if (args[index] === "--out") out = args[++index]
    else if (args[index] === "--e2e-env") e2eEnv = args[++index]
  }
  const spec = buildTqSpec({ specs, unflaggedAssert: args.includes("--unflagged-assert"), control: args.includes("--control"), e2eEnv })
  const json = JSON.stringify(spec, null, 1)
  if (out) fs.writeFileSync(out, json)
  else process.stdout.write(json + "\n")
}
