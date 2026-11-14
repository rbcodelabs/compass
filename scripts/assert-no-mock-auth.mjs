#!/usr/bin/env node
/**
 * Fails when the e2e mock-auth marker is present in a built Next artifact.
 *
 * Runs at the end of the `build` script whenever COMPASS_E2E_MOCK_AUTH_BUILD is not "1" (so every Vercel build asserts).
 * It proves the ARTIFACT, not the source: lib/e2e-harness.ts and lib/e2e-mock-auth.ts carry the marker string, and the
 * minifier must have removed both from a build that did not opt in.
 *
 * Scans every non-.map file under <dir>/server and <dir>/static. Never scans <dir>/cache (it holds prior builds' unminified
 * modules and is not deployed). Source maps embed original sources (sourcesContent) whether or not the code was eliminated, so a
 * map containing the marker is reported as information and does not fail the build: server maps ship only inside the private
 * function bundle, and browser source maps are off unless productionBrowserSourceMaps is enabled.
 *
 * Usage: node scripts/assert-no-mock-auth.mjs [--dir .next] [--skip-when-mock-build]
 * --skip-when-mock-build exits 0 without scanning when COMPASS_E2E_MOCK_AUTH_BUILD is exactly "1" (the e2e build, which is
 * supposed to contain the marker). Any other value, or unset, scans.
 */
import fs from "node:fs"
import path from "node:path"

export const MARKER = "compass-e2e-mock-auth-v1"
const markerBuffer = Buffer.from(MARKER)

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

function* walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile()) yield full
  }
}

if (process.argv.includes("--skip-when-mock-build") && process.env.COMPASS_E2E_MOCK_AUTH_BUILD === "1") {
  console.log("assert-no-mock-auth: skipped, COMPASS_E2E_MOCK_AUTH_BUILD=1 (e2e build, marker expected).")
  process.exit(0)
}

const root = path.resolve(argValue("--dir", ".next"))
const scanned = ["server", "static"].map((name) => path.join(root, name)).filter((dir) => fs.existsSync(dir))
if (scanned.length === 0) {
  console.error(`assert-no-mock-auth: nothing to scan, ${root}/server and ${root}/static do not exist (a failed or missing build must not pass).`)
  process.exit(1)
}

const hits = []
const mapHits = []
let files = 0
for (const directory of scanned) {
  for (const file of walk(directory)) {
    files += 1
    if (!fs.readFileSync(file).includes(markerBuffer)) continue
    ;(file.endsWith(".map") ? mapHits : hits).push(path.relative(root, file))
  }
}

if (mapHits.length > 0) {
  console.log(`assert-no-mock-auth: info, ${mapHits.length} source map file(s) contain the marker as source text (not executable code).`)
}
if (hits.length > 0) {
  console.error(`assert-no-mock-auth: FAIL, marker ${MARKER} found in ${hits.length} deployable file(s) of ${root}:`)
  for (const hit of hits.slice(0, 20)) console.error(`  ${hit}`)
  if (hits.length > 20) console.error(`  ... and ${hits.length - 20} more`)
  console.error("The e2e mock login must not be compiled into a build that did not set COMPASS_E2E_MOCK_AUTH_BUILD=1.")
  process.exit(1)
}
console.log(`assert-no-mock-auth: ok, no mock-auth marker in ${files} files under ${scanned.map((dir) => path.relative(root, dir)).join(", ")}.`)
