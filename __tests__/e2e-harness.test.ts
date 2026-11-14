import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const GOOD: Record<string, string> = {
  E2E_MOCK_AUTH: "1",
  E2E_ISOLATED_DATABASE: "1",
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/compass_e2e",
}

// A sentinel, not a default parameter: `undefined` must mean "the build flag is unset", not "use the default".
const UNSET = Symbol("unset")
type Build = string | typeof UNSET

async function load(build: Build) {
  vi.resetModules()
  if (build === UNSET) delete process.env.COMPASS_E2E_MOCK_AUTH_BUILD
  else process.env.COMPASS_E2E_MOCK_AUTH_BUILD = build
  return import("@/lib/e2e-harness")
}

async function mockEnabled(env: Record<string, string | undefined>, build: Build = "1") {
  return (await load(build)).e2eMockAuthEnabled(env as NodeJS.ProcessEnv)
}

async function harnessEnabled(env: Record<string, string | undefined>, build: Build = UNSET) {
  return (await load(build)).e2eHarnessEnabled(env as NodeJS.ProcessEnv)
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
    expect(await mockEnabled(GOOD)).toBe(true)
  })

  it("is off for the empty environment", async () => {
    expect(await mockEnabled({})).toBe(false)
  })

  it.each([[UNSET], [""], ["true"], ["0"], [" 1"]] as [Build][])("is off when the build flag is %s", async (build) => {
    expect(await mockEnabled(GOOD, build)).toBe(false)
  })

  it.each(["E2E_MOCK_AUTH", "E2E_ISOLATED_DATABASE", "DATABASE_URL"])("is off when %s is missing", async (name) => {
    const env = { ...GOOD }
    delete env[name]
    expect(await mockEnabled(env)).toBe(false)
  })

  it.each([["E2E_MOCK_AUTH", "true"], ["E2E_MOCK_AUTH", "0"], ["E2E_ISOLATED_DATABASE", "true"], ["E2E_ISOLATED_DATABASE", ""]])(
    "is off when %s is %j rather than exactly 1",
    async (name, value) => {
      expect(await mockEnabled({ ...GOOD, [name]: value })).toBe(false)
    },
  )

  it.each(["?host=db.prod.example.com", "?hostaddr=10.0.0.5", "?sslmode=disable&host=other"])(
    "is off when DATABASE_URL carries a connection-host override query parameter (%s)",
    async (query) => {
      expect(await mockEnabled({ ...GOOD, DATABASE_URL: `postgres://postgres:postgres@localhost:5432/compass_e2e${query}` })).toBe(false)
    },
  )

  it("still accepts harmless query parameters", async () => {
    expect(await mockEnabled({ ...GOOD, DATABASE_URL: "postgres://postgres:postgres@localhost:5432/compass_e2e?sslmode=disable" })).toBe(true)
  })

  it("is off for a remote host, a database not named compass_e2e, or an unparseable URL", async () => {
    expect(await mockEnabled({ ...GOOD, DATABASE_URL: "postgres://u:p@db.example.com:5432/compass_e2e" })).toBe(false)
    expect(await mockEnabled({ ...GOOD, DATABASE_URL: "postgres://u:p@localhost:5432/compass" })).toBe(false)
    expect(await mockEnabled({ ...GOOD, DATABASE_URL: "postgres://u:p@localhost:5432/compass_e2e_other" })).toBe(false)
    expect(await mockEnabled({ ...GOOD, DATABASE_URL: "not a url" })).toBe(false)
  })

  it.each(["postgres://u:p@127.0.0.1:5432/compass_e2e", "postgres://u:p@[::1]:5432/compass_e2e"])("accepts the local host %s", async (url) => {
    expect(await mockEnabled({ ...GOOD, DATABASE_URL: url })).toBe(true)
  })

  it.each([["VERCEL", "1"], ["VERCEL_ENV", "production"], ["VERCEL_ENV", "preview"], ["PGHOST", "x.dsql.example"], ["AWS_ROLE_ARN", "arn:aws:iam::1:role/x"]])(
    "throws (loud, not silent) when %s=%s is present on a flagged build",
    async (name, value) => {
      await expect(mockEnabled({ ...GOOD, [name]: value })).rejects.toThrow(/refusing to boot/)
    },
  )

  it("does not throw for a deployed variable on an unflagged build, it is simply off", async () => {
    expect(await mockEnabled({ ...GOOD, VERCEL_ENV: "production" }, UNSET)).toBe(false)
    expect(await mockEnabled({ ...GOOD, VERCEL: "1" }, "")).toBe(false)
  })

  it("is off when the active schema is not compass_dev", async () => {
    process.env.VERCEL_ENV = "preview"
    expect(await mockEnabled(GOOD)).toBe(false)
    delete process.env.VERCEL_ENV
    process.env.PGSCHEMA = "other"
    expect(await mockEnabled(GOOD)).toBe(false)
  })
})

describe("e2eHarnessEnabled", () => {
  const saved = { ...process.env }
  beforeEach(() => {
    delete process.env.VERCEL_ENV
    delete process.env.PGSCHEMA
    delete process.env.PREVIEW_AUTOMATION_ENABLED
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  it("is true for the old dev condition: not production and E2E_FUNCTIONAL=1", async () => {
    expect(await harnessEnabled({ NODE_ENV: "development", E2E_FUNCTIONAL: "1" })).toBe(true)
    expect(await harnessEnabled({ NODE_ENV: "test", E2E_FUNCTIONAL: "1" })).toBe(true)
  })

  it("is false for the old dev condition when production or E2E_FUNCTIONAL is not exactly 1", async () => {
    expect(await harnessEnabled({})).toBe(false)
    expect(await harnessEnabled({ NODE_ENV: "development" })).toBe(false)
    expect(await harnessEnabled({ NODE_ENV: "production", E2E_FUNCTIONAL: "1" })).toBe(false)
    expect(await harnessEnabled({ NODE_ENV: "development", E2E_FUNCTIONAL: "true" })).toBe(false)
  })

  it("is true under mock mode on a production build, even though NODE_ENV is production", async () => {
    expect(await harnessEnabled({ ...GOOD, NODE_ENV: "production", E2E_FUNCTIONAL: "1" }, "1")).toBe(true)
  })

  it("is false on a production build without the build flag, whatever the runtime env says", async () => {
    expect(await harnessEnabled({ ...GOOD, NODE_ENV: "production", E2E_FUNCTIONAL: "1" }, UNSET)).toBe(false)
    expect(await harnessEnabled({ ...GOOD, NODE_ENV: "production", E2E_FUNCTIONAL: "1" }, "")).toBe(false)
  })

  it("is false on a flagged production build when mock mode is off at runtime", async () => {
    expect(await harnessEnabled({ NODE_ENV: "production", E2E_FUNCTIONAL: "1" }, "1")).toBe(false)
    expect(await harnessEnabled({ ...GOOD, E2E_MOCK_AUTH: "", NODE_ENV: "production" }, "1")).toBe(false)
  })

  it("throws on a flagged production build that sees a deployed variable", async () => {
    await expect(harnessEnabled({ ...GOOD, NODE_ENV: "production", VERCEL_ENV: "production" }, "1")).rejects.toThrow(/refusing to boot/)
  })
})
