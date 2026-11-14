import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { prodBuildProblem } from "../scripts/e2e-prod-build-check.mjs"

let dir: string
let buildId: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-prod-build-"))
  buildId = path.join(dir, "BUILD_ID")
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe("prodBuildProblem", () => {
  it("refuses a missing build and names the command that makes one", () => {
    expect(prodBuildProblem({ buildIdPath: buildId, headCommitMs: Date.now() })).toMatch(/missing.*pnpm build:e2e/s)
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
