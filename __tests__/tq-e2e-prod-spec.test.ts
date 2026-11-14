import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
// The generator is plain ESM JavaScript (allowJs); it is run by hand to produce a `tq submit --spec` file.
import { buildTqSpec } from "../scripts/tq-e2e-prod-spec.mjs"

const SCRIPT = path.resolve(__dirname, "../scripts/tq-e2e-prod-spec.mjs")
const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("buildTqSpec", () => {
  const spec = buildTqSpec({ specs: ["e2e/functional/specs/analytics.spec.ts"] })
  const step = (name: string, from = spec) => {
    const found = from.steps.find((candidate) => candidate.name === name)
    if (!found) throw new Error(`no step ${name}`)
    return found
  }

  it("orders install, browsers, database, build, assert, e2e and leaves unflaggedAssert off by default", () => {
    expect(spec.steps.map((candidate) => candidate.name)).toEqual(["install", "playwright-browsers", "create-e2e-db", "build", "assert", "e2e"])
    expect(buildTqSpec().steps.some((candidate) => candidate.name === "build-unflagged-assert")).toBe(false)
  })

  it("sets PLAYWRIGHT_SKIP_BROWSER_GC=1 in env to avoid shared browser cache contention across workers", () => {
    expect(spec.env.PLAYWRIGHT_SKIP_BROWSER_GC).toBe("1")
  })

  it("builds with CI=1 and the mock-auth flag through pnpm build:e2e, only in the build step", () => {
    expect(step("build").run).toContain("CI=1")
    expect(step("build").run).toContain("build:e2e")
    for (const name of ["install", "playwright-browsers", "create-e2e-db", "assert", "e2e"]) expect(step(name).run).not.toContain("COMPASS_E2E_MOCK_AUTH_BUILD")
  })

  it("asserts that the flagged artifact contains the marker, so the unflagged assert cannot be vacuous", () => {
    expect(step("assert").run).toContain("compass-e2e-mock-auth-v1")
  })

  it("runs the suite against the compass_e2e database on the prod server with the requested specs", () => {
    const run = step("e2e").run
    expect(run).toContain("compass_e2e")
    expect(run).toContain("E2E_SERVER=prod")
    expect(run).toContain("e2e/functional/specs/analytics.spec.ts")
    expect(spec.database).toBe(true)
    expect(spec.reserve_mb).toBe(8192)
  })

  it("can build an unflagged artifact first and prove it contains no marker", () => {
    const withUnflagged = buildTqSpec({ specs: [], unflaggedAssert: true })
    const build = step("build-unflagged-assert", withUnflagged)
    expect(build.run).toContain("pnpm build")
    expect(withUnflagged.steps.map((candidate) => candidate.name).indexOf("build-unflagged-assert")).toBeLessThan(
      withUnflagged.steps.map((candidate) => candidate.name).indexOf("build"),
    )
  })

  it("a control job pins the dev server explicitly, since prod is now the default", () => {
    expect(step("e2e", buildTqSpec({ specs: [], control: true })).run).toContain("E2E_SERVER=dev")
  })

  it("runs the full suite when no specs are given", () => {
    expect(step("e2e", buildTqSpec({ specs: [] })).run).not.toContain("e2e/functional/specs/")
    expect(step("e2e", buildTqSpec({ specs: [] })).run).toMatch(/corepack pnpm run test:e2e:functional$/)
  })

  it("passes --shard=k/N for both empty and non-empty specs", () => {
    const shard1Full = step("e2e", buildTqSpec({ specs: [], shard: "1/2" })).run
    const shard2Full = step("e2e", buildTqSpec({ specs: [], shard: "2/2" })).run
    expect(shard1Full).toMatch(/corepack pnpm run test:e2e:functional -- --shard=1\/2$/)
    expect(shard2Full).toMatch(/corepack pnpm run test:e2e:functional -- --shard=2\/2$/)

    const shard1Filtered = step("e2e", buildTqSpec({ specs: ["a.spec.ts", "b.spec.ts"], shard: "1/2" })).run
    const shard2Filtered = step("e2e", buildTqSpec({ specs: ["a.spec.ts", "b.spec.ts"], shard: "2/2" })).run
    expect(shard1Filtered).toMatch(/corepack pnpm run test:e2e:functional -- --shard=1\/2 a\.spec\.ts b\.spec\.ts$/)
    expect(shard2Filtered).toMatch(/corepack pnpm run test:e2e:functional -- --shard=2\/2 a\.spec\.ts b\.spec\.ts$/)
  })

  it.each(["0/2", "3/2", "1/0", "1", "abc", "1/2; rm -rf", ""])("rejects invalid shard %j", (badShard) => {
    expect(() => buildTqSpec({ specs: [], shard: badShard })).toThrow(/shard/i)
  })

  it("writes N shard spec files via CLI --shards N --out-prefix <prefix> and prints their paths", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-e2e-prod-spec-"))
    tempDirs.push(dir)
    const prefix = path.join(dir, "e2e")
    const result = spawnSync(process.execPath, [SCRIPT, "--shards", "2", "--out-prefix", prefix], { encoding: "utf8" })
    expect(result.status, result.stderr).toBe(0)

    const expectedPaths = [path.join(dir, "e2e-1-of-2.json"), path.join(dir, "e2e-2-of-2.json")]
    expect(result.stdout.trim().split("\n")).toEqual(expectedPaths)

    const shard1 = JSON.parse(fs.readFileSync(expectedPaths[0], "utf8")) as ReturnType<typeof buildTqSpec>
    const shard2 = JSON.parse(fs.readFileSync(expectedPaths[1], "utf8")) as ReturnType<typeof buildTqSpec>
    expect(step("e2e", shard1).run).toMatch(/corepack pnpm run test:e2e:functional -- --shard=1\/2$/)
    expect(step("e2e", shard2).run).toMatch(/corepack pnpm run test:e2e:functional -- --shard=2\/2$/)
    expect(shard1.steps.some((candidate) => candidate.name === "build-unflagged-assert")).toBe(false)
  })

  it("supports CLI --shard k/N for a single generated spec and rejects conflicting CLI flags", () => {
    const single = spawnSync(process.execPath, [SCRIPT, "--shard", "1/2"], { encoding: "utf8" })
    expect(single.status, single.stderr).toBe(0)
    const parsed = JSON.parse(single.stdout) as ReturnType<typeof buildTqSpec>
    expect(step("e2e", parsed).run).toMatch(/corepack pnpm run test:e2e:functional -- --shard=1\/2$/)

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-e2e-prod-spec-"))
    tempDirs.push(dir)
    const prefix = path.join(dir, "e2e")
    for (const badArgs of [
      ["--shards", "2"],
      ["--shards", "2", "--out-prefix", prefix, "--shard", "1/2"],
      ["--shards", "2", "--out-prefix", prefix, "--out", path.join(dir, "single.json")],
      ["--shards", "0", "--out-prefix", prefix],
    ]) {
      const res = spawnSync(process.execPath, [SCRIPT, ...badArgs], { encoding: "utf8" })
      expect(res.status, `expected failure for ${badArgs.join(" ")}`).not.toBe(0)
    }
  })
})
