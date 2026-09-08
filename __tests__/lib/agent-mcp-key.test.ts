import { describe, it, expect, vi, beforeEach } from "vitest"
import { createHash } from "node:crypto"

const mockApiKey = { create: vi.fn(), update: vi.fn() }
vi.mock("@/lib/db", () => ({ default: () => ({ apiKey: mockApiKey }) }))

import { mintAgentMcpKey, mintResearchAgentMcpKey, revokeAgentMcpKey, withAgentMcpKey } from "@/lib/agent-mcp-key"

beforeEach(() => vi.clearAllMocks())

describe("mintAgentMcpKey", () => {
  it("mints a validateMcpAuth-compatible token and stores its hash (not the raw token)", async () => {
    mockApiKey.create.mockResolvedValue({ id: "key-1" })
    const { token, apiKeyId } = await mintAgentMcpKey("user-1", "workspace-1")

    // Format matches lib/mcp-auth.ts: cmp_ + 32 hex, length 36.
    expect(token).toMatch(/^cmp_[0-9a-f]{32}$/)
    expect(token.length).toBe(36)
    expect(apiKeyId).toBe("key-1")

    const data = mockApiKey.create.mock.calls[0][0].data
    expect(data.userId).toBe("user-1")
    expect(data.purpose).toBe("AGENT_TURN")
    expect(data.scopeWorkspaceId).toBe("workspace-1")
    expect(data.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(300_000)
    expect(data.keyHash).toBe(createHash("sha256").update(token).digest("hex"))
    expect(data.keyPrefix).toBe(token.slice(4, 12))
    // The raw token must never be persisted.
    expect(JSON.stringify(data)).not.toContain(token)
  })

  it("mints unique tokens across calls", async () => {
    mockApiKey.create.mockResolvedValue({ id: "k" })
    const a = await mintAgentMcpKey("u", "w")
    const b = await mintAgentMcpKey("u", "w")
    expect(a.token).not.toBe(b.token)
  })

  it("locks research-agent credentials to one workspace", async () => {
    mockApiKey.create.mockResolvedValue({ id: "research-key" })
    await mintResearchAgentMcpKey("user-1", "workspace-1")

    expect(mockApiKey.create.mock.calls[0][0].data).toMatchObject({
      userId: "user-1",
      name: "research-interview (ephemeral)",
      purpose: "RESEARCH",
      scopeWorkspaceId: "workspace-1",
      expiresAt: expect.any(Date),
    })
    expect(mockApiKey.create.mock.calls[0][0].data.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })
})

describe("revokeAgentMcpKey", () => {
  it("sets revokedAt and never throws", async () => {
    mockApiKey.update.mockResolvedValue({})
    await revokeAgentMcpKey("key-1")
    expect(mockApiKey.update.mock.calls[0][0]).toMatchObject({ where: { id: "key-1" } })
    expect(mockApiKey.update.mock.calls[0][0].data.revokedAt).toBeInstanceOf(Date)

    mockApiKey.update.mockRejectedValueOnce(new Error("db down"))
    await expect(revokeAgentMcpKey("key-2")).resolves.toBeUndefined() // swallowed
  })
})

describe("withAgentMcpKey", () => {
  it("provides the token then revokes it, even on error", async () => {
    mockApiKey.create.mockResolvedValue({ id: "key-9" })
    mockApiKey.update.mockResolvedValue({})

    const seen = await withAgentMcpKey("user-1", "workspace-1", async (token) => {
      expect(token).toMatch(/^cmp_[0-9a-f]{32}$/)
      return "done"
    })
    expect(seen).toBe("done")
    expect(mockApiKey.update).toHaveBeenCalledWith({ where: { id: "key-9" }, data: { revokedAt: expect.any(Date) } })

    // Revokes even when the body throws.
    mockApiKey.create.mockResolvedValue({ id: "key-10" })
    await expect(
      withAgentMcpKey("user-1", "workspace-1", async () => {
        throw new Error("turn failed")
      })
    ).rejects.toThrow("turn failed")
    expect(mockApiKey.update).toHaveBeenCalledWith({ where: { id: "key-10" }, data: { revokedAt: expect.any(Date) } })
  })
})
