import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mockRun = vi.fn()
const mockClient = { marker: "admin-dsql-client" }

vi.mock("@/lib/admin-dsql-pool", () => ({
  withAdminDsqlClient: (operation: (client: unknown) => unknown) => operation(mockClient),
}))

vi.mock("@/lib/shared-comments-backfill", () => ({
  runSharedCommentsBackfill: (...args: unknown[]) => mockRun(...args),
}))

import { POST } from "@/app/api/admin/shared-comments-backfill/route"

function request(body: unknown, secret = "test-secret") {
  return new NextRequest("http://localhost/api/admin/shared-comments-backfill", {
    method: "POST",
    headers: { "content-type": "application/json", "x-migration-secret": secret },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.MIGRATION_SECRET = "test-secret"
  mockRun.mockResolvedValue({ operation: "validate", complete: true, invariants: { passed: true } })
})

describe("POST /api/admin/shared-comments-backfill", () => {
  it("fails closed without the configured migration secret", async () => {
    const response = await POST(request({ operation: "validate" }, "wrong"))
    expect(response.status).toBe(401)
    expect(mockRun).not.toHaveBeenCalled()
  })

  it("runs validation through the authenticated admin DSQL client", async () => {
    const response = await POST(request({ operation: "validate" }))
    expect(response.status).toBe(200)
    expect(mockRun).toHaveBeenCalledWith(mockClient, { operation: "validate", batchSize: 500 })
  })

  it("accepts a bounded backfill batch size", async () => {
    await POST(request({ operation: "backfill", batchSize: 100 }))
    expect(mockRun).toHaveBeenCalledWith(mockClient, { operation: "backfill", batchSize: 100 })
  })

  it.each([0, 501, 1.5, "100"])("rejects invalid batch size %j", async (batchSize) => {
    const response = await POST(request({ operation: "backfill", batchSize }))
    expect(response.status).toBe(400)
    expect(mockRun).not.toHaveBeenCalled()
  })

  it("rejects unknown operations", async () => {
    const response = await POST(request({ operation: "delete" }))
    expect(response.status).toBe(400)
    expect(mockRun).not.toHaveBeenCalled()
  })

  it("returns a conflict without sensitive row data when invariants fail", async () => {
    mockRun.mockResolvedValue({
      operation: "backfill",
      complete: false,
      invariants: { passed: false, orphanedDocComments: 1, orphanedSolutionComments: 0 },
    })
    const response = await POST(request({ operation: "backfill" }))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      operation: "backfill",
      complete: false,
      invariants: { passed: false, orphanedDocComments: 1, orphanedSolutionComments: 0 },
    })
  })
})
