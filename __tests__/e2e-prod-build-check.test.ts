import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { e2eServerMode, prodBuildProblem } from "../scripts/e2e-prod-build-check.mjs"

let dir: string
let buildId: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-prod-build-"))
  buildId = path.join(dir, "BUILD_ID")
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe("prodBuildProblem", () => {
  it("refuses a missing build and names the command that makes one", () => {
    expect(prodBuildProblem({ buildIdPath: buildId, headCommitMs: Date.now() })).toMatch(/missing[\s\S]*pnpm build:e2e/)
  })

  it("refuses a build older than the HEAD commit", () => {
    fs.writeFileSync(buildId, "x")
    const built = fs.statSync(buildId).mtimeMs
    expect(prodBuildProblem({ buildIdPath: buildId, headCommitMs: built + 60_000 })).toMatch(/older than HEAD/)
  })

  it("accepts a build at or after the HEAD commit", () => {
    fs.writeFileSync(buildId, "x")
    const built = fs.statSync(buildId).mtimeMs
    expect(prodBuildProblem({ buildIdPath: buildId, headCommitMs: built })).toBeNull()
    expect(prodBuildProblem({ buildIdPath: buildId, headCommitMs: built - 60_000 })).toBeNull()
  })
})

describe("e2eServerMode", () => {
  it("defaults to the production build", () => {
    expect(e2eServerMode(undefined)).toBe("prod")
    expect(e2eServerMode("")).toBe("prod")
    expect(e2eServerMode("prod")).toBe("prod")
  })

  it("opts back into the dev server only with the exact value dev", () => {
    expect(e2eServerMode("dev")).toBe("dev")
  })

  it("rejects anything else instead of silently picking a mode", () => {
    expect(() => e2eServerMode("production")).toThrow(/E2E_SERVER/)
    expect(() => e2eServerMode("DEV")).toThrow(/E2E_SERVER/)
  })
})

describe("prodBuildProblem message", () => {
  it("is one line and names both ways forward when missing or stale", () => {
    const missing = prodBuildProblem({ buildIdPath: "/nope/BUILD_ID", headCommitMs: Date.now() }) as string
    expect(missing.split("\n")).toHaveLength(1)
    expect(missing).toContain("pnpm build:e2e")
    expect(missing).toContain("E2E_SERVER=dev")

    fs.writeFileSync(buildId, "x")
    const built = fs.statSync(buildId).mtimeMs
    const stale = prodBuildProblem({ buildIdPath: buildId, headCommitMs: built + 60_000 }) as string
    expect(stale.split("\n")).toHaveLength(1)
    expect(stale).toContain("pnpm build:e2e")
    expect(stale).toContain("E2E_SERVER=dev")
  })
})
