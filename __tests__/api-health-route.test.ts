import { describe, it, expect, vi, beforeEach } from "vitest"

// The probe must never reach the database or auth. These mocks make any such
// import fail the test loudly instead of silently widening what a health check
// depends on.
vi.mock("@/lib/db", () => ({ default: () => { throw new Error("health route must not touch the database") } }))
vi.mock("@/lib/auth-config", () => ({ getAuthStrategy: () => { throw new Error("health route must not read auth config") } }))

import { GET, HEAD, dynamic, runtime } from "@/app/api/health/route"

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  it("answers 200 with a fixed JSON body", async () => {
    const res = GET()
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toMatch(/application\/json/)
    expect(await res.json()).toEqual({ status: "ok" })
  })

  it("is never cached", () => {
    expect(GET().headers.get("cache-control")).toBe("no-store")
    expect(dynamic).toBe("force-dynamic")
  })

  it("runs on the Node runtime", () => {
    expect(runtime).toBe("nodejs")
  })

  it("does not depend on any environment configuration", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("VERCEL_ENV", "")
    vi.stubEnv("DATABASE_URL", "")
    vi.stubEnv("PGHOST", "")
    const res = GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ok" })
  })

  it("does not leak anything beyond the status field", async () => {
    const body = (await GET().json()) as Record<string, unknown>
    expect(Object.keys(body)).toEqual(["status"])
  })

  it("answers HEAD with 200 and no body", async () => {
    const res = HEAD()
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("")
  })
})
