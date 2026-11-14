import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const SCRIPT = path.resolve(__dirname, "../scripts/assert-no-mock-auth.mjs")
const MARKER = "compass-e2e-mock-auth-v1"

let dir: string

function write(rel: string, content: string) {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function run(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" })
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "assert-no-mock-auth-"))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe("scripts/assert-no-mock-auth.mjs", () => {
  it("passes on a clean artifact", () => {
    write("server/chunks/a.js", "console.log('dev-credentials is unrelated text')")
    write("static/chunks/b.js", "var x=1")
    const result = run("--dir", dir)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("no mock-auth marker")
  })

  it.each(["server/chunks/a.js", "static/chunks/b.js", "server/app/page.js.nft.json", "server/app/x.html"])("fails when the marker is in %s", (rel) => {
    write(rel, `var m="${MARKER}"`)
    const result = run("--dir", dir)
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toContain(rel)
  })

  it.each(["e2e-no-provider", "Test analysis: participant described", "x-e2e-pm-fail-receipt-finalization"])(
    "fails when the functional-suite fake %j is in a deployable file",
    (fake) => {
      write("server/chunks/fake.js", `var f="${fake}"`)
      const result = run("--dir", dir)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(fake)
    },
  )

  it("refuses --skip-when-mock-build on Vercel, where a flagged build must never happen", () => {
    write("server/a.js", "ok")
    const result = spawnSync(process.execPath, [SCRIPT, "--dir", dir, "--skip-when-mock-build"], { encoding: "utf8", env: { ...process.env, VERCEL: "1", COMPASS_E2E_MOCK_AUTH_BUILD: "1" } })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("VERCEL")
  })

  it("never looks in the build cache", () => {
    write("cache/webpack/x.pack", `var m="${MARKER}"`)
    write("server/a.js", "ok")
    expect(run("--dir", dir).status).toBe(0)
  })

  it("reports source maps that contain the marker as information, without failing", () => {
    write("server/a.js", "ok")
    write("server/a.js.map", `{"sourcesContent":["${MARKER}"]}`)
    write("static/chunks/b.js.map", `{"sourcesContent":["${MARKER}"]}`)
    const result = run("--dir", dir)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("2 source map file(s) contain the marker")
  })

  it("is skipped on the e2e build itself, where the marker is expected", () => {
    write("server/a.js", `var m="${MARKER}"`)
    const skipped = spawnSync(process.execPath, [SCRIPT, "--dir", dir, "--skip-when-mock-build"], { encoding: "utf8", env: { ...process.env, COMPASS_E2E_MOCK_AUTH_BUILD: "1" } })
    expect(skipped.status).toBe(0)
    expect(skipped.stdout).toContain("skipped")
    // Any other value of the flag still asserts.
    for (const value of ["", "true", "0"]) {
      const asserted = spawnSync(process.execPath, [SCRIPT, "--dir", dir, "--skip-when-mock-build"], { encoding: "utf8", env: { ...process.env, COMPASS_E2E_MOCK_AUTH_BUILD: value } })
      expect(asserted.status).toBe(1)
    }
    const unset = { ...process.env }
    delete unset.COMPASS_E2E_MOCK_AUTH_BUILD
    expect(spawnSync(process.execPath, [SCRIPT, "--dir", dir, "--skip-when-mock-build"], { encoding: "utf8", env: unset }).status).toBe(1)
  })

  it("fails closed when the artifact directory has no server or static output", () => {
    const result = run("--dir", dir)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("nothing to scan")
  })

  it("scans large files and does not choke on binary content", () => {
    write("server/big.js", "a".repeat(5_000_000) + MARKER)
    expect(run("--dir", dir).status).toBe(1)
    fs.mkdirSync(path.join(dir, "static"), { recursive: true })
    fs.writeFileSync(path.join(dir, "static/bin.woff2"), Buffer.from([0, 255, 1, 2, 3]))
    write("server/ok.js", "x")
    fs.rmSync(path.join(dir, "server/big.js"))
    expect(run("--dir", dir).status).toBe(0)
  })
})
