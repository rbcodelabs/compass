import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const pruneAgentData = vi.hoisted(() => vi.fn())
vi.mock("@/lib/db", () => ({ default: () => ({}) }))
vi.mock("@/lib/agent-retention", () => ({ pruneAgentData }))

import { GET, POST } from "@/app/api/cron/agent-retention/route"

const request = (headers: Record<string, string> = {}, method = "GET") => new Request("http://localhost/api/cron/agent-retention", { method, headers })
const original = { cron: process.env.CRON_SECRET, migration: process.env.MIGRATION_SECRET }

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.CRON_SECRET
  delete process.env.MIGRATION_SECRET
  vi.spyOn(console, "info").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})
afterEach(() => {
  if (original.cron === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = original.cron
  if (original.migration === undefined) delete process.env.MIGRATION_SECRET; else process.env.MIGRATION_SECRET = original.migration
})

describe("/api/cron/agent-retention", () => {
  it("fails closed with 503 when no secret is configured, even for a request that presents one", async () => {
    const response = await GET(request({ authorization: "Bearer anything" }))
    expect(response.status).toBe(503)
    expect(pruneAgentData).not.toHaveBeenCalled()
  })

  it("requires CRON_SECRET itself: MIGRATION_SECRET alone is a 503, and a Vercel Cron call logs loudly", async () => {
    process.env.MIGRATION_SECRET = "migration-secret"
    const response = await GET(request({ "x-migration-secret": "migration-secret" }))
    expect(response.status).toBe(503)
    expect(console.error).not.toHaveBeenCalled()
    const cron = await GET(request({ "user-agent": "vercel-cron/1.0" }))
    expect(cron.status).toBe(503)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("RETENTION IS NOT RUNNING"))
    expect(pruneAgentData).not.toHaveBeenCalled()
  })

  it("401s without or with the wrong credential", async () => {
    process.env.CRON_SECRET = "cron-secret"
    expect((await GET(request())).status).toBe(401)
    expect((await GET(request({ authorization: "Bearer nope" }))).status).toBe(401)
    expect((await GET(request({ "x-migration-secret": "cron-secret" }))).status).toBe(401)
    expect(pruneAgentData).not.toHaveBeenCalled()
  })

  it("runs for Vercel Cron's bearer, and for an operator with MIGRATION_SECRET via POST", async () => {
    process.env.CRON_SECRET = "cron-secret"
    process.env.MIGRATION_SECRET = "migration-secret"
    pruneAgentData.mockResolvedValue({ messagesDeleted: 2, truncated: false })
    const viaCron = await GET(request({ authorization: "Bearer cron-secret" }))
    expect(viaCron.status).toBe(200)
    expect(await viaCron.json()).toMatchObject({ messagesDeleted: 2 })
    const viaOperator = await POST(request({ "x-migration-secret": "migration-secret" }, "POST"))
    expect(viaOperator.status).toBe(200)
    expect(pruneAgentData).toHaveBeenCalledTimes(2)
  })

  it("reports a failed run as a 500 without leaking the error", async () => {
    process.env.CRON_SECRET = "cron-secret"
    pruneAgentData.mockRejectedValue(new Error("db password is hunter2"))
    const response = await GET(request({ authorization: "Bearer cron-secret" }))
    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain("hunter2")
  })
})
