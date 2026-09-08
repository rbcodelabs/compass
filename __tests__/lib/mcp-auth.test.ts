import { beforeEach, describe, expect, it, vi } from "vitest"

const apiKey = { findFirst: vi.fn(), update: vi.fn() }
const agent = { findFirst: vi.fn() }
vi.mock("@/lib/db", () => ({ default: () => ({ apiKey, agent }) }))

import { validateMcpAuth } from "@/lib/mcp-auth"

function request() {
  return new Request("https://compass.test/api/mcp", {
    headers: { authorization: `Bearer cmp_${"a".repeat(32)}` },
  })
}

describe("MCP credential expiry", () => {
  beforeEach(() => vi.clearAllMocks())
  it("derives agent identity from the stored credential and checks its human owner", async () => {
    vi.stubEnv("COMPASS_AGENTS_ENABLED", "1")
    apiKey.findFirst.mockResolvedValue({ id: "key", userId: "user", purpose: "AGENT", agentId: "agent", expiresAt: null })
    apiKey.update.mockResolvedValue({})
    agent.findFirst.mockResolvedValueOnce({ id: "agent" })
    await expect(validateMcpAuth(request())).resolves.toMatchObject({ valid: true, purpose: "AGENT", userId: "user", agentId: "agent", credentialId: "key" })
    expect(agent.findFirst).toHaveBeenCalledWith({ where: { id: "agent", ownerUserId: "user", status: "ACTIVE" }, select: { id: true } })
    agent.findFirst.mockResolvedValueOnce(null)
    await expect(validateMcpAuth(request())).resolves.toEqual({ valid: false })
    vi.unstubAllEnvs()
  })
  it("rejects personal credentials carrying an agent identity", async () => {
    apiKey.findFirst.mockResolvedValue({ id: "key", userId: "user", purpose: null, agentId: "agent", expiresAt: null })
    await expect(validateMcpAuth(request())).resolves.toEqual({ valid: false })
  })

  it("rejects a registered-agent key while rollout is disabled", async () => {
    vi.stubEnv("COMPASS_AGENTS_ENABLED", "0")
    apiKey.findFirst.mockResolvedValue({ id: "key", userId: "user", purpose: "AGENT", agentId: "agent", expiresAt: null })
    apiKey.update.mockResolvedValue({})
    await expect(validateMcpAuth(request())).resolves.toEqual({ valid: false })
    vi.unstubAllEnvs()
  })

  it("rejects an assistant-turn credential without workspace and expiry", async () => {
    apiKey.findFirst.mockResolvedValue({ id: "key", userId: "user", purpose: "AGENT_TURN", expiresAt: null })
    apiKey.update.mockResolvedValue({})
    await expect(validateMcpAuth(request())).resolves.toEqual({ valid: false })
  })

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
