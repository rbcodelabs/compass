import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const upsert = vi.fn(async ({ where }: { where: { email: string } }) => ({ id: "u1", email: where.email, name: "Dev User" }))
vi.mock("@/lib/db", () => ({ default: () => ({ user: { upsert } }) }))

const MOCK_ENV = {
  E2E_MOCK_AUTH: "1",
  E2E_ISOLATED_DATABASE: "1",
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/compass_e2e",
}

async function authorize(credentials: Record<string, unknown> | undefined) {
  vi.resetModules()
  const { authorizeMockUser } = await import("@/lib/e2e-mock-auth")
  return authorizeMockUser(credentials)
}

describe("authorizeMockUser re-checks the guard on every call", () => {
  beforeEach(() => {
    upsert.mockClear()
    for (const name of ["VERCEL", "VERCEL_ENV", "PGHOST", "AWS_ROLE_ARN", "PGSCHEMA", "PREVIEW_AUTOMATION_ENABLED"]) vi.stubEnv(name, undefined)
  })
  afterEach(() => vi.unstubAllEnvs())

  it("signs in nobody and never touches the database outside development and without mock mode", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("COMPASS_E2E_MOCK_AUTH_BUILD", "")
    for (const [k, v] of Object.entries(MOCK_ENV)) vi.stubEnv(k, v)
    expect(await authorize({ email: "x@example.com" })).toBeNull()
    expect(upsert).not.toHaveBeenCalled()
  })

  it("signs in nobody on a flagged build when the runtime flag is missing", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("COMPASS_E2E_MOCK_AUTH_BUILD", "1")
    vi.stubEnv("E2E_ISOLATED_DATABASE", "1")
    vi.stubEnv("DATABASE_URL", MOCK_ENV.DATABASE_URL)
    expect(await authorize({ email: "x@example.com" })).toBeNull()
    expect(upsert).not.toHaveBeenCalled()
  })

  it("throws (never signs in) on a flagged build when a deployed variable appears after boot", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("COMPASS_E2E_MOCK_AUTH_BUILD", "1")
    for (const [k, v] of Object.entries(MOCK_ENV)) vi.stubEnv(k, v)
    vi.stubEnv("VERCEL_ENV", "production")
    await expect(authorize({ email: "x@example.com" })).rejects.toThrow(/refusing to boot/)
    expect(upsert).not.toHaveBeenCalled()
  })

  it("upserts the requested email in mock mode and defaults to the dev user", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("COMPASS_E2E_MOCK_AUTH_BUILD", "1")
    for (const [k, v] of Object.entries(MOCK_ENV)) vi.stubEnv(k, v)
    expect(await authorize({ email: "second@example.com" })).toEqual({ id: "u1", email: "second@example.com", name: "Dev User" })
    expect((await authorize(undefined))?.email).toBe("dev@localhost.dev")
    expect(upsert).toHaveBeenCalledTimes(2)
  })

  it("keeps working in plain development, as before", async () => {
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("COMPASS_E2E_MOCK_AUTH_BUILD", "")
    expect(await authorize({ email: "dev@localhost.dev" })).toEqual({ id: "u1", email: "dev@localhost.dev", name: "Dev User" })
  })
})
