import { beforeEach, describe, expect, it, vi } from "vitest"

const apiKey = { findFirst: vi.fn(), update: vi.fn() }
vi.mock("@/lib/db", () => ({ default: () => ({ apiKey }) }))

import { validateMcpAuth } from "@/lib/mcp-auth"

function request() {
  return new Request("https://compass.test/api/mcp", {
    headers: { authorization: `Bearer cmp_${"a".repeat(32)}` },
  })
}

describe("MCP credential expiry", () => {
  beforeEach(() => vi.clearAllMocks())

  it("accepts an unexpired research credential", async () => {
    apiKey.findFirst.mockResolvedValue({
      id: "key-1",
      userId: "user-1",
      purpose: "RESEARCH",
      scopeWorkspaceId: "workspace-1",
      expiresAt: new Date(Date.now() + 60_000),
    })
    apiKey.update.mockResolvedValue({})

    await expect(validateMcpAuth(request())).resolves.toMatchObject({
      valid: true,
      purpose: "RESEARCH",
    })
  })

  it("fails closed after research credential expiry even if revocation cleanup failed", async () => {
    apiKey.findFirst.mockResolvedValue(null)

    await expect(validateMcpAuth(request())).resolves.toEqual({ valid: false })
    expect(apiKey.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        revokedAt: null,
        OR: expect.arrayContaining([{ expiresAt: { gt: expect.any(Date) } }]),
      }),
    }))
  })

  it("keeps existing persistent user keys valid when expiry is null", async () => {
    apiKey.findFirst.mockResolvedValue({
      id: "key-2",
      userId: "user-2",
      purpose: null,
      scopeWorkspaceId: null,
      expiresAt: null,
    })
    apiKey.update.mockResolvedValue({})

    await expect(validateMcpAuth(request())).resolves.toMatchObject({
      valid: true,
      purpose: "USER",
    })
  })

  it("keeps the configured service credential independent of database expiry", async () => {
    vi.stubEnv("MCP_API_KEY", "service-secret")
    const serviceRequest = new Request("https://compass.test/api/mcp", {
      headers: { authorization: "Bearer service-secret" },
    })

    await expect(validateMcpAuth(serviceRequest)).resolves.toEqual({
      valid: true,
      userId: null,
      purpose: "SERVICE",
      scopeWorkspaceId: null,
    })
    expect(apiKey.findFirst).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })
})
