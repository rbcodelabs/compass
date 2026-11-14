import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"

const root = process.cwd()
const read = (rel: string) => fs.readFileSync(path.resolve(root, rel), "utf8")
const FLAGS = ["COMPASS_E2E_MOCK_AUTH_BUILD", "E2E_MOCK_AUTH"]

/** Files that configure a deployed build. None may ever turn the e2e mock login on. */
const DEPLOY_CONFIG = ["vercel.json", ".env.example"]

const savedEnv = { ...process.env }
afterEach(() => {
  process.env = { ...savedEnv }
})

async function loadNextConfig(env: { COMPASS_E2E_MOCK_AUTH_BUILD?: string; VERCEL?: string }) {
  vi.resetModules()
  if (env.COMPASS_E2E_MOCK_AUTH_BUILD === undefined) delete process.env.COMPASS_E2E_MOCK_AUTH_BUILD
  else process.env.COMPASS_E2E_MOCK_AUTH_BUILD = env.COMPASS_E2E_MOCK_AUTH_BUILD
  if (env.VERCEL === undefined) delete process.env.VERCEL
  else process.env.VERCEL = env.VERCEL
  const mod = await import("../next.config")
  return mod.default
}

describe("e2e mock login is never enabled by deploy configuration", () => {
  test.each(DEPLOY_CONFIG)("%s does not mention the mock-auth flags", (file) => {
    const text = read(file)
    for (const flag of FLAGS) expect(text, `${file} must not mention ${flag}`).not.toContain(flag)
  })

  test("CI workflows that build the app do not set the flags", () => {
    const dir = path.resolve(root, ".github/workflows")
    for (const name of fs.readdirSync(dir)) {
      const text = fs.readFileSync(path.join(dir, name), "utf8")
      for (const flag of FLAGS) expect(text, `${name} must not mention ${flag}`).not.toContain(flag)
    }
  })

  test("next.config.ts only passes the build flag through as a literal that is exactly '1' or empty, and never mentions the runtime flag", () => {
    const text = read("next.config.ts")
    expect(text).not.toContain("E2E_MOCK_AUTH:")
    expect(text).not.toMatch(/E2E_MOCK_AUTH(?!_BUILD)/)
    const assignments = text.match(/^\s*COMPASS_E2E_MOCK_AUTH_BUILD\s*:[^\n]*/gm)?.map((line) => line.trim()) ?? []
    expect(assignments).toEqual(['COMPASS_E2E_MOCK_AUTH_BUILD: process.env.COMPASS_E2E_MOCK_AUTH_BUILD === "1" ? "1" : "",'])
  })

  test("the default build and install scripts never set the flag, and the build asserts the artifact", () => {
    const { scripts } = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
    for (const name of ["build", "postinstall", "start", "dev"]) {
      for (const flag of FLAGS) expect(scripts[name] ?? "", `scripts.${name} must not set ${flag}`).not.toContain(flag)
    }
    expect(scripts.build).toContain("node scripts/assert-no-mock-auth.mjs --skip-when-mock-build")
    expect(scripts.build.indexOf("next build")).toBeLessThan(scripts.build.indexOf("assert-no-mock-auth"))
    // The e2e build is the only script that opts in, and it never runs the assert that would fail it.
    expect(scripts["build:e2e"]).toContain("COMPASS_E2E_MOCK_AUTH_BUILD=1")
    expect(scripts["build:e2e"]).not.toContain("assert-no-mock-auth")
  })

  test("the build flag is only read where it is inlined next to a predicate call, never through NEXT_PUBLIC_", () => {
    const text = read("next.config.ts")
    expect(text).not.toContain("NEXT_PUBLIC_E2E")
    expect(text).not.toContain("NEXT_PUBLIC_COMPASS_E2E")
  })

  test("next.config.ts skips built-in TypeScript checking ONLY for non-Vercel COMPASS_E2E_MOCK_AUTH_BUILD=1 builds", async () => {
    expect((await loadNextConfig({})).typescript?.ignoreBuildErrors).toBe(false)
    expect((await loadNextConfig({ COMPASS_E2E_MOCK_AUTH_BUILD: "" })).typescript?.ignoreBuildErrors).toBe(false)
    expect((await loadNextConfig({ COMPASS_E2E_MOCK_AUTH_BUILD: "1" })).typescript?.ignoreBuildErrors).toBe(true)
    expect((await loadNextConfig({ COMPASS_E2E_MOCK_AUTH_BUILD: "1", VERCEL: "1" })).typescript?.ignoreBuildErrors).toBe(false)
  })
})
