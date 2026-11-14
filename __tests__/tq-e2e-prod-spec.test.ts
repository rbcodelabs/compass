import { describe, expect, it } from "vitest"
// The generator is plain ESM JavaScript (allowJs); it is run by hand to produce a `tq submit --spec` file.
import { buildTqSpec } from "../scripts/tq-e2e-prod-spec.mjs"

describe("buildTqSpec", () => {
  const spec = buildTqSpec({ specs: ["e2e/functional/specs/analytics.spec.ts"] })
  const step = (name: string) => spec.steps.find((candidate: { name: string }) => candidate.name === name)

  it("orders install, browsers, database, build, assert, e2e", () => {
    expect(spec.steps.map((candidate: { name: string }) => candidate.name)).toEqual(["install", "playwright-browsers", "create-e2e-db", "build", "assert", "e2e"])
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
    const run = step("e2e").run as string
    expect(run).toContain("compass_e2e")
    expect(run).toContain("E2E_SERVER=prod")
    expect(run).toContain("e2e/functional/specs/analytics.spec.ts")
    expect(spec.database).toBe(true)
    expect(spec.reserve_mb).toBe(8192)
  })

  it("can build an unflagged artifact first and prove it contains no marker", () => {
    const withUnflagged = buildTqSpec({ specs: [], unflaggedAssert: true })
    const build = withUnflagged.steps.find((candidate: { name: string }) => candidate.name === "build-unflagged-assert")
    expect(build.run).toContain("pnpm build")
    expect(withUnflagged.steps.map((candidate: { name: string }) => candidate.name).indexOf("build-unflagged-assert")).toBeLessThan(
      withUnflagged.steps.map((candidate: { name: string }) => candidate.name).indexOf("build"),
    )
  })

  it("runs the full suite when no specs are given", () => {
    expect(buildTqSpec({ specs: [] }).steps.find((candidate: { name: string }) => candidate.name === "e2e").run).not.toContain("e2e/functional/specs/")
  })
})
