/**
 * Guard tests for the agent turn route (app/api/agent/turn/route.ts).
 *
 * Covers the security-critical early returns before any sandbox is booted:
 * session required, input validation, workspace-membership authorization,
 * conversation ownership, and runtime prerequisites. The streamed happy path
 * (real sandbox boot + agent run) is verified end-to-end against a deploy.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockAuth = vi.fn()
vi.mock("@/auth", () => ({ auth: () => mockAuth() }))

const mockPrisma = {
  workspace: { findFirst: vi.fn() },
  agentConversation: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  agentMessage: { create: vi.fn(), findMany: vi.fn() },
  workspaceCapabilityPack: { findMany: vi.fn() },
}
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

const mockGetGoldenSnapshotId = vi.fn()
vi.mock("@/lib/agent-runtime-config", () => ({ getGoldenSnapshotId: () => mockGetGoldenSnapshotId() }))
// Sandbox + key modules should never be reached in guard tests; stub them safely.
const mockBootSandbox = vi.fn()
const mockMintKey = vi.fn()
const mockRevokeKey = vi.fn()
vi.mock("@/lib/agent-sandbox", () => ({ bootSandboxFromSnapshot: (...args: unknown[]) => mockBootSandbox(...args) }))
vi.mock("@/lib/agent-mcp-key", () => ({ mintAgentMcpKey: (...args: unknown[]) => mockMintKey(...args), revokeAgentMcpKey: (...args: unknown[]) => mockRevokeKey(...args) }))
const mockPreparePacks = vi.fn()
vi.mock("@/lib/capability-pack-runtime", () => ({ prepareCapabilityPacksForTurn: (...args: unknown[]) => mockPreparePacks(...args) }))
vi.mock("@/lib/artifact-storage", () => ({ getArtifactStorage: () => ({}) }))

const mockCheckLimit = vi.fn()
vi.mock("@/lib/agent-limits", () => ({ checkAgentUsageLimit: () => mockCheckLimit() }))

import { POST } from "@/app/api/agent/turn/route"

function req(body: unknown): NextRequest {
  return new NextRequest("https://compass.rbcodelabs.com/api/agent/turn", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
}

const SESSION = { user: { id: "user-1" } }

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ANTHROPIC_API_KEY = "sk-ant-test"
  mockAuth.mockResolvedValue(SESSION)
  mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
  mockPrisma.workspaceCapabilityPack.findMany.mockResolvedValue([])
  mockGetGoldenSnapshotId.mockResolvedValue("snap_abc")
  mockCheckLimit.mockResolvedValue({ allowed: true })
  mockMintKey.mockResolvedValue({ token: "token", apiKeyId: "key-1" })
  mockPreparePacks.mockResolvedValue({ files: [], pluginPaths: [], skillIds: [], provenanceJson: "[]", systemPromptAppendices: [] })
})

describe("agent turn route — guards", () => {
  it("401 when there is no session", async () => {
    mockAuth.mockResolvedValue(null)
    const res = await POST(req({ workspaceId: "ws-1", message: "hi" }))
    expect(res.status).toBe(401)
  })

  it("400 on missing/empty message or workspaceId", async () => {
    expect((await POST(req({ workspaceId: "ws-1", message: "   " }))).status).toBe(400)
    expect((await POST(req({ message: "hi" }))).status).toBe(400)
  })

  it("429 when the user is over their daily rate/cost limit", async () => {
    mockCheckLimit.mockResolvedValue({ allowed: false, reason: "Daily agent turn limit reached (100/day)." })
    const res = await POST(req({ workspaceId: "ws-1", message: "hi" }))
    expect(res.status).toBe(429)
    expect(await res.text()).toMatch(/limit reached/)
  })

  it("404 when the caller is not a member of the workspace", async () => {
    mockPrisma.workspace.findFirst.mockResolvedValue(null)
    const res = await POST(req({ workspaceId: "ws-x", message: "hi" }))
    expect(res.status).toBe(404)
    // Membership filter is applied.
    expect(mockPrisma.workspace.findFirst).toHaveBeenCalledWith({
      where: { id: "ws-x", members: { some: { userId: "user-1" } } },
      select: { id: true, name: true, slug: true, organization: { select: { slug: true } } },
    })
  })

  it("404 when a supplied conversationId is not owned by the user in this workspace", async () => {
    mockPrisma.agentConversation.findFirst.mockResolvedValue(null)
    const res = await POST(req({ workspaceId: "ws-1", message: "hi", conversationId: "c-999" }))
    expect(res.status).toBe(404)
    expect(mockPrisma.agentConversation.findFirst).toHaveBeenCalledWith({
      where: { id: "c-999", userId: "user-1", workspaceId: "ws-1" },
      select: { id: true },
    })
  })

  it("503 when no golden snapshot has been built", async () => {
    mockGetGoldenSnapshotId.mockResolvedValue(null)
    mockPrisma.agentConversation.create.mockResolvedValue({ id: "c-1" })
    const res = await POST(req({ workspaceId: "ws-1", message: "hi" }))
    expect(res.status).toBe(503)
  })

  it("500 when ANTHROPIC_API_KEY is not configured", async () => {
    delete process.env.ANTHROPIC_API_KEY
    mockPrisma.agentConversation.create.mockResolvedValue({ id: "c-1" })
    const res = await POST(req({ workspaceId: "ws-1", message: "hi" }))
    expect(res.status).toBe(500)
  })

  it("revokes the acting-user MCP key when capability-pack preparation fails", async () => {
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1", name: "Test", slug: "test", organization: { slug: "org" } })
    mockPrisma.agentConversation.create.mockResolvedValue({ id: "c-1" })
    mockPrisma.agentMessage.findMany.mockResolvedValue([{ role: "user", content: "hi" }])
    mockPreparePacks.mockRejectedValue(new Error("artifact digest mismatch"))
    const response = await POST(req({ workspaceId: "ws-1", message: "hi" }))
    expect(await response.text()).toContain("artifact digest mismatch")
    expect(mockBootSandbox).not.toHaveBeenCalled()
    expect(mockRevokeKey).toHaveBeenCalledWith("key-1")
  })
})
