import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const GOOD: Record<string, string> = {
  E2E_MOCK_AUTH: "1",
  E2E_ISOLATED_DATABASE: "1",
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/compass_e2e",
}

const UNSET = Symbol("unset")

async function enabled(env: Record<string, string | undefined>, build: string | typeof UNSET = "1") {
  vi.resetModules()
  if (build === UNSET) delete process.env.COMPASS_E2E_MOCK_AUTH_BUILD
  else process.env.COMPASS_E2E_MOCK_AUTH_BUILD = build
  const { e2eMockAuthEnabled } = await import("@/lib/e2e-harness")
  return e2eMockAuthEnabled(env as NodeJS.ProcessEnv)
}

describe("e2eMockAuthEnabled", () => {
  const saved = { ...process.env }
  beforeEach(() => {
    delete process.env.VERCEL_ENV
    delete process.env.PGSCHEMA
    delete process.env.PREVIEW_AUTOMATION_ENABLED
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  it("is on only when every condition holds", async () => {
    expect(await enabled(GOOD)).toBe(true)
  })
  it("is off for the empty environment and when the build flag is unset or not exactly 1", async () => {
    expect(await enabled({})).toBe(false)
    expect(await enabled(GOOD, UNSET)).toBe(false)
    expect(await enabled(GOOD, "")).toBe(false)
    expect(await enabled(GOOD, "true")).toBe(false)
  })
  it.each(["E2E_MOCK_AUTH", "E2E_ISOLATED_DATABASE", "DATABASE_URL"])("is off when %s is missing", async (name) => {
    const env = { ...GOOD }
    delete env[name]
    expect(await enabled(env)).toBe(false)
  })
  it("is off for a remote host or a database not named compass_e2e", async () => {
    expect(await enabled({ ...GOOD, DATABASE_URL: "postgres://u:p@db.example.com:5432/compass_e2e" })).toBe(false)
    expect(await enabled({ ...GOOD, DATABASE_URL: "postgres://u:p@localhost:5432/compass" })).toBe(false)
    expect(await enabled({ ...GOOD, DATABASE_URL: "not a url" })).toBe(false)
  })
  it.each([["VERCEL", "1"], ["VERCEL_ENV", "production"], ["VERCEL_ENV", "preview"], ["PGHOST", "x.dsql.example"], ["AWS_ROLE_ARN", "arn:aws:iam::1:role/x"]])(
    "throws (loud, not silent) when %s=%s is set on a flagged build",
    async (name, value) => {
      await expect(enabled({ ...GOOD, [name]: value })).rejects.toThrow(/refusing to boot/)
    },
  )
  it("is off when the active schema is not compass_dev", async () => {
    process.env.VERCEL_ENV = "preview"
    expect(await enabled(GOOD)).toBe(false)
  })
})
