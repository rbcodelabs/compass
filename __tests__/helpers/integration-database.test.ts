import { afterEach, describe, expect, it, vi } from "vitest"
import {
  INTEGRATION_DATABASE_ENV,
  LEGACY_INTEGRATION_DATABASE_ENVS,
  assertSafeIntegrationDatabaseUrl,
  readIntegrationDatabaseUrl,
} from "./integration-database"

const SAFE = "postgresql://postgres:postgres@localhost:5432/compass_e2e"

describe("integration database opt-in guard", () => {
  afterEach(() => vi.restoreAllMocks())

  it("is named INTEGRATION_TEST_DATABASE_URL", () => {
    expect(INTEGRATION_DATABASE_ENV).toBe("INTEGRATION_TEST_DATABASE_URL")
  })

  it.each([
    SAFE,
    "postgres://postgres:pw@127.0.0.1:5440/compass_e2e",
    `${SAFE}?sslmode=disable`,
    `${SAFE}?sslmode=prefer`,
  ])("accepts %s", (url) => {
    expect(() => assertSafeIntegrationDatabaseUrl(url)).not.toThrow()
  })

  it.each([
    ["a remote host", "postgresql://postgres:pw@db.example.com:5432/compass_e2e"],
    ["a remote host that merely contains localhost", "postgresql://postgres:pw@localhost.evil.com:5432/compass_e2e"],
    ["the wrong database", "postgresql://postgres:pw@localhost:5432/postgres"],
    ["a schema override", `${SAFE}?schema=public`],
    ["a host override", `${SAFE}?host=evil.example.com`],
    ["a hostaddr override", `${SAFE}?hostaddr=10.0.0.5`],
    ["a dbname override", `${SAFE}?dbname=prod`],
    ["an options override", `${SAFE}?options=-c%20search_path%3Dpublic`],
    ["an sslmode outside the allowlist", `${SAFE}?sslmode=require`],
    ["an unknown parameter next to a good one", `${SAFE}?sslmode=disable&application_name=x`],
    ["a non-postgres protocol", "mysql://root:pw@localhost:3306/compass_e2e"],
    ["an unparseable value", "not a url"],
  ])("rejects %s", (_label, url) => {
    expect(() => assertSafeIntegrationDatabaseUrl(url)).toThrow(/INTEGRATION_TEST_DATABASE_URL/)
  })

  it("returns undefined when unset or blank so suites skip", () => {
    expect(readIntegrationDatabaseUrl({})).toBeUndefined()
    expect(readIntegrationDatabaseUrl({ INTEGRATION_TEST_DATABASE_URL: "  " })).toBeUndefined()
  })

  it("returns the validated URL when set", () => {
    expect(readIntegrationDatabaseUrl({ INTEGRATION_TEST_DATABASE_URL: SAFE })).toBe(SAFE)
  })

  it("throws instead of skipping when set to an unsafe value", () => {
    expect(() => readIntegrationDatabaseUrl({ INTEGRATION_TEST_DATABASE_URL: "postgresql://u:p@prod.example.com/compass_e2e" })).toThrow()
  })

  it("hints to rename when only an old per-feature variable is set, and does not honour it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(readIntegrationDatabaseUrl({ TOOL_APPROVAL_DATABASE_URL: SAFE })).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain("TOOL_APPROVAL_DATABASE_URL")
    expect(String(warn.mock.calls[0][0])).toContain("INTEGRATION_TEST_DATABASE_URL")
  })

  it("stays quiet about old variables once the new one is set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    readIntegrationDatabaseUrl({ INTEGRATION_TEST_DATABASE_URL: SAFE, TOOL_APPROVAL_DATABASE_URL: SAFE })
    expect(warn).not.toHaveBeenCalled()
  })

  it("lists the per-feature names it replaces", () => {
    expect(LEGACY_INTEGRATION_DATABASE_ENVS).toContain("WORKSPACE_ID_TEST_DATABASE_URL")
    expect(LEGACY_INTEGRATION_DATABASE_ENVS).not.toContain("DATABASE_URL")
  })
})
