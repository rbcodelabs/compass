import { beforeEach, describe, expect, it, vi } from "vitest"

const prisma = {
  workspace: { findUnique: vi.fn() },
  artifact: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  artifactRevision: { findFirst: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
}
const callConnectorTool = vi.fn()

vi.mock("@/lib/db", () => ({ default: () => prisma }))
const listConnectorToolNames = vi.hoisted(() => vi.fn())
vi.mock("@/lib/mcp-connectors/call", () => ({ callConnectorTool: (...a: unknown[]) => callConnectorTool(...a), listConnectorToolNames: (...a: unknown[]) => listConnectorToolNames(...a) }))

import { McpConnectorError } from "@/lib/mcp-connectors/config"
import { createV0Artifact, extractV0Preview, extractV0Snapshot, fetchV0Preview, parseV0ChatUrl, refreshV0Artifact } from "@/lib/v0-artifacts"

beforeEach(() => {
  vi.clearAllMocks()
  prisma.$transaction.mockImplementation(async (cb) => cb(prisma))
})

describe("parseV0ChatUrl", () => {
  it.each([
    ["https://v0.app/chat/abc123", "abc123"],
    ["https://v0.app/chat/abc123/", "abc123"],
    ["  https://v0.app/chat/abc_123-X?ref=1#top ", "abc_123-X"],
    ["https://v0.dev/chat/abc123", "abc123"],
    ["https://v0.app/chat/my-chat-title-AbC123", "AbC123"],
    ["https://v0.app/acme-team/chat/weekly-roadmap-prototype-i9vLk0cKmQl", "i9vLk0cKmQl"],
    ["https://v0.app/chat/i9vLk0cKmQl", "i9vLk0cKmQl"],
  ])("accepts %s", (raw, chatId) => {
    const parsed = parseV0ChatUrl(raw)
    expect(parsed.chatId).toBe(chatId)
    expect(parsed.url).toBe(`https://v0.app/chat/${chatId}`)
  })

  it.each([
    "not a url",
    "http://v0.app/chat/abc123",
    "https://evil.example/chat/abc123",
    "https://v0.app.evil.example/chat/abc123",
    "https://v0.app/project/abc123",
    "https://v0.app/a/b/chat/abc123",
    "https://v0.app/team/chat/",
    "https://v0.app/chat",
    "https://user:pw@v0.app/chat/abc123",
    "https://v0.app/chat/a",
    "javascript:alert(1)",
  ])("rejects %s", (raw) => {
    expect(() => parseV0ChatUrl(raw)).toThrow()
  })
})

describe("extractV0Snapshot", () => {
  it("prefers the latest version id", () => {
    const snap = extractV0Snapshot({ id: "c1", name: "Dash", latestVersion: { id: "v9" }, messages: [{ id: "m1" }], updatedAt: "t" }, "c1")
    expect(snap).toMatchObject({ chatId: "c1", title: "Dash", versionId: "v9", url: "https://v0.app/chat/c1" })
  })

  it("unwraps a chat envelope and falls back to the last message id, then updatedAt", () => {
    expect(extractV0Snapshot({ chat: { id: "c1", messages: [{ id: "m1" }, { id: "m2" }] } }, "c1").versionId).toBe("m2")
    expect(extractV0Snapshot({ id: "c1", updatedAt: "2026-01-01T00:00:00Z" }, "c1").versionId).toBe("2026-01-01T00:00:00Z")
  })

  it("rejects a different chat, an unreadable payload, and a payload with no version marker", () => {
    expect(() => extractV0Snapshot({ id: "other", latestVersion: { id: "v1" } }, "c1")).toThrow(/different chat/)
    expect(() => extractV0Snapshot(null, "c1")).toThrow(/could not read/)
    expect(() => extractV0Snapshot({ id: "c1" }, "c1")).toThrow(/cannot tell whether it changed/)
  })

  it("ignores a returned URL for another chat", () => {
    const snap = extractV0Snapshot({ id: "c1", latestVersion: { id: "v1" }, webUrl: "https://v0.app/chat/zzz999" }, "c1")
    expect(snap.url).toBe("https://v0.app/chat/c1")
  })
})

describe("extractV0Snapshot — live v0 chats_get shape (observed 2026-10-06)", () => {
  it("unwraps { success, data } and uses title and updatedAt", () => {
    const live = { success: true, data: { id: "yrnT9IQACcD", title: "Deposits Auction Vision", privacy: "team-edit", updatedAt: "2026-10-06T14:37:30.866Z", metadata: {} }, message: "chats.get completed" }
    expect(extractV0Snapshot(live, "yrnT9IQACcD")).toEqual({
      chatId: "yrnT9IQACcD", title: "Deposits Auction Vision", versionId: "2026-10-06T14:37:30.866Z", url: "https://v0.app/chat/yrnT9IQACcD",
    })
  })
})

describe("fetchV0Snapshot tool-name fallback", () => {
  it("falls back to the next tool name only when the tool is unknown", async () => {
    const { fetchV0Snapshot } = await import("@/lib/v0-artifacts")
    callConnectorTool.mockRejectedValueOnce(new McpConnectorError("GATEWAY_FAILED", "chats_get failed: Unknown tool: chats_get"))
    callConnectorTool.mockResolvedValueOnce({ structured: { id: "abc123", updatedAt: "t1" }, text: "" })
    expect((await fetchV0Snapshot("user-1", "abc123")).versionId).toBe("t1")
    expect(callConnectorTool.mock.calls.map((c) => c[0].toolName)).toEqual(["chats_get", "getChat"])
  })

  it("asks the server for its tool list when neither known name exists, and uses a get-chat tool it finds", async () => {
    const { fetchV0Snapshot } = await import("@/lib/v0-artifacts")
    callConnectorTool.mockRejectedValueOnce(new McpConnectorError("GATEWAY_FAILED", "Tool chats_get not found"))
    callConnectorTool.mockRejectedValueOnce(new McpConnectorError("GATEWAY_FAILED", "Tool getChat not found"))
    listConnectorToolNames.mockResolvedValueOnce(["createChat", "chats_retrieve", "findChats"])
    callConnectorTool.mockResolvedValueOnce({ structured: { id: "abc123", updatedAt: "t2" }, text: "" })
    expect((await fetchV0Snapshot("user-1", "abc123")).versionId).toBe("t2")
    expect(callConnectorTool.mock.calls.map((c) => c[0].toolName)).toEqual(["chats_get", "getChat", "chats_retrieve"])
  })

  it("names the tools the server does offer when none fits", async () => {
    const { fetchV0Snapshot } = await import("@/lib/v0-artifacts")
    callConnectorTool.mockRejectedValue(new McpConnectorError("GATEWAY_FAILED", "Tool x not found"))
    listConnectorToolNames.mockResolvedValueOnce(["createChat", "findChats"])
    await expect(fetchV0Snapshot("user-1", "abc123")).rejects.toThrow(/offers: createChat, findChats/)
  })

  it("does not retry under another name for auth or other failures", async () => {
    const { fetchV0Snapshot } = await import("@/lib/v0-artifacts")
    callConnectorTool.mockRejectedValue(new McpConnectorError("REFRESH_FAILED", "Reconnect v0"))
    await expect(fetchV0Snapshot("user-1", "abc123")).rejects.toThrow(/Reconnect v0/)
    expect(callConnectorTool).toHaveBeenCalledTimes(1)
  })
})

describe("createV0Artifact", () => {
  it("reads v0 as the acting user, then creates the artifact with revision 1", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ id: "ws-1" })
    callConnectorTool.mockResolvedValue({ structured: { id: "abc123", name: "Pricing page", latestVersion: { id: "v1" } }, text: "" })
    prisma.artifact.create.mockResolvedValue({ id: "art-1", title: "Pricing page" })
    prisma.artifactRevision.create.mockResolvedValue({ id: "rev-1" })
    prisma.artifact.update.mockResolvedValue({})

    const artifact = await createV0Artifact({ workspaceId: "ws-1", url: "https://v0.app/chat/abc123", userId: "user-1", source: "UI" })

    expect(callConnectorTool).toHaveBeenCalledWith(expect.objectContaining({ slug: "v0", userId: "user-1", args: { chatId: "abc123" } }))
    expect(prisma.artifact.create.mock.calls[0][0].data).toMatchObject({ sourceType: "V0_CHAT", v0ChatId: "abc123", title: "Pricing page" })
    expect(prisma.artifactRevision.create.mock.calls[0][0].data).toMatchObject({
      revisionNumber: 1, v0VersionId: "v1", externalUrl: "https://v0.app/chat/abc123",
    })
    expect(artifact.currentRevisionId).toBe("rev-1")
  })

  it("uses an explicit title over the chat name", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ id: "ws-1" })
    callConnectorTool.mockResolvedValue({ structured: { id: "abc123", name: "Chat name", latestVersion: { id: "v1" } }, text: "" })
    prisma.artifact.create.mockResolvedValue({ id: "art-1" })
    prisma.artifactRevision.create.mockResolvedValue({ id: "rev-1" })
    await createV0Artifact({ workspaceId: "ws-1", url: "https://v0.app/chat/abc123", title: "Mine", userId: "user-1", source: "UI" })
    expect(prisma.artifact.create.mock.calls[0][0].data.title).toBe("Mine")
  })

  it("writes nothing when v0 is not connected", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ id: "ws-1" })
    callConnectorTool.mockRejectedValue(new McpConnectorError("NOT_CONNECTED", "You have not connected v0 to Compass."))
    await expect(createV0Artifact({ workspaceId: "ws-1", url: "https://v0.app/chat/abc123", userId: "user-1", source: "UI" })).rejects.toThrow(/not connected v0/)
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(prisma.artifact.create).not.toHaveBeenCalled()
  })

  it("requires a user (not a service key) and a valid URL, before any call", async () => {
    await expect(createV0Artifact({ workspaceId: "ws-1", url: "https://v0.app/chat/abc123", userId: null, source: "MCP" })).rejects.toThrow(/signed-in user/)
    await expect(createV0Artifact({ workspaceId: "ws-1", url: "https://example.com", userId: "user-1", source: "MCP" })).rejects.toThrow(/v0 chat URL/)
    expect(callConnectorTool).not.toHaveBeenCalled()
  })
})

describe("refreshV0Artifact", () => {
  const base = { artifactId: "art-1", workspaceId: "ws-1", userId: "user-1", source: "UI" as const }
  const artifactRow = (over: Record<string, unknown> = {}) => ({
    id: "art-1", status: "ACTIVE", v0ChatId: "abc123", currentRevision: { revisionNumber: 2, v0VersionId: "v2" }, ...over,
  })
  const chat = (versionId: string) => ({ structured: { id: "abc123", latestVersion: { id: versionId } }, text: "" })

  it("adds no revision when v0 has nothing new", async () => {
    prisma.artifact.findFirst.mockResolvedValue(artifactRow())
    callConnectorTool.mockResolvedValue(chat("v2"))
    const result = await refreshV0Artifact(base)
    expect(result).toEqual({ changed: false, revisionNumber: 2, versionId: "v2" })
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(prisma.artifactRevision.create).not.toHaveBeenCalled()
  })

  it("adds the next revision and moves the current pointer when v0 has a new version", async () => {
    prisma.artifact.findFirst.mockResolvedValue(artifactRow())
    callConnectorTool.mockResolvedValue(chat("v3"))
    prisma.artifactRevision.findFirst.mockResolvedValue({ revisionNumber: 2 })
    prisma.artifactRevision.create.mockResolvedValue({ id: "rev-3" })
    prisma.artifact.update.mockResolvedValue({})
    const result = await refreshV0Artifact(base)
    expect(result).toEqual({ changed: true, revisionId: "rev-3", revisionNumber: 3, versionId: "v3" })
    expect(prisma.artifactRevision.create.mock.calls[0][0].data).toMatchObject({ artifactId: "art-1", revisionNumber: 3, v0VersionId: "v3" })
    expect(prisma.artifact.update.mock.calls[0][0].data).toMatchObject({ currentRevisionId: "rev-3" })
  })

  it("reports no change when a concurrent refresh already took the revision number", async () => {
    prisma.artifact.findFirst.mockResolvedValue(artifactRow())
    callConnectorTool.mockResolvedValue(chat("v3"))
    prisma.artifactRevision.findFirst.mockResolvedValue({ revisionNumber: 2 })
    prisma.$transaction.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }))
    expect(await refreshV0Artifact(base)).toMatchObject({ changed: false })
  })

  it("looks the artifact up inside the declared workspace and only for V0_CHAT", async () => {
    prisma.artifact.findFirst.mockResolvedValue(null)
    await expect(refreshV0Artifact(base)).rejects.toThrow(/not found/)
    expect(prisma.artifact.findFirst.mock.calls[0][0].where).toEqual({ id: "art-1", workspaceId: "ws-1", sourceType: "V0_CHAT" })
    expect(callConnectorTool).not.toHaveBeenCalled()
  })

  it("rejects archived artifacts without calling v0", async () => {
    prisma.artifact.findFirst.mockResolvedValue(artifactRow({ status: "ARCHIVED" }))
    await expect(refreshV0Artifact(base)).rejects.toThrow(/Archived/)
    expect(callConnectorTool).not.toHaveBeenCalled()
  })

  it("propagates a connector failure without writing", async () => {
    prisma.artifact.findFirst.mockResolvedValue(artifactRow())
    callConnectorTool.mockRejectedValue(new McpConnectorError("REFRESH_FAILED", "Reconnect v0"))
    await expect(refreshV0Artifact(base)).rejects.toThrow(/Reconnect v0/)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })
})

describe("extractV0Preview", () => {
  const ok = { success: true, data: { url: "https://demo-abc.v0.build", token: "tok.en", expiresAt: "2026-10-07T00:00:00Z" } }
  it("returns the preview origin, token and expiry (the token is never put in a URL)", () => {
    const preview = extractV0Preview(ok)
    expect(preview).toEqual({ url: "https://demo-abc.v0.build/", token: "tok.en", expiresAt: "2026-10-07T00:00:00Z" })
  })
  it.each([
    ["not ready (null data)", { success: true, data: null }],
    ["no url", { success: true, data: {} }],
    ["foreign host", { data: { url: "https://evil.example.com" } }],
    ["look-alike host", { data: { url: "https://v0.build.evil.com" } }],
    ["http", { data: { url: "http://demo.v0.build" } }],
    ["credentials", { data: { url: "https://u:p@demo.v0.build" } }],
    ["garbage", "nope"],
  ])("returns null for %s", (_label, payload) => { expect(extractV0Preview(payload)).toBeNull() })
})

describe("fetchV0Preview", () => {
  const ok = { structured: { data: { url: "https://demo-abc.v0.build", token: "t" } } }
  it("falls back to tools/list discovery when the known names are missing", async () => {
    callConnectorTool.mockRejectedValueOnce(new Error("Tool chats_getPreview not found")).mockRejectedValueOnce(new Error("Tool getPreview not found")).mockResolvedValueOnce(ok)
    listConnectorToolNames.mockResolvedValue(["get_chat_preview"])
    expect((await fetchV0Preview("u1", "abc"))?.url).toContain("demo-abc.v0.build")
    expect(callConnectorTool).toHaveBeenLastCalledWith(expect.objectContaining({ toolName: "get_chat_preview", userId: "u1", args: { chatId: "abc" } }))
  })
  it("never throws: an unconnected v0 yields null", async () => {
    callConnectorTool.mockRejectedValue(new Error("v0 is not connected"))
    expect(await fetchV0Preview("u1", "abc")).toBeNull()
  })
  it("gives up after the timeout instead of stalling the page", async () => {
    callConnectorTool.mockReturnValue(new Promise(() => {}))
    expect(await fetchV0Preview("u1", "abc", 20)).toBeNull()
  })
})
