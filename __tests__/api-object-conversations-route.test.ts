import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), membership: vi.fn(), rows: vi.fn(), links: vi.fn(), backfill: vi.fn(),
}))
vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("@/lib/db", () => ({ default: () => ({ workspaceMember: { findFirst: mocks.membership }, agentConversation: { findMany: mocks.rows } }) }))
vi.mock("@/lib/links/conversation-links", () => ({ isConversationLinkTarget: () => true, listConversationsForObject: mocks.links }))
vi.mock("@/lib/doc-comment-tasks", () => ({ loadMentionCandidates: async () => ({ people: [], agents: [], outside: [] }) }))
vi.mock("@/lib/unified-conversations-backfill", () => ({ backfillUnifiedConversations: mocks.backfill }))
import { GET } from "@/app/api/agent/conversations/by-target/route"
import { accessibleConversationsWhere } from "@/lib/agent-conversation-access"

const request = () => new NextRequest("http://localhost/api/agent/conversations/by-target?workspaceId=workspace&targetType=TASK&targetId=task")
const row = (id: string, anchored = false) => ({ id, title: id, summary: null, status: "OPEN", agentMode: "MENTION_ONLY", visibility: "WORKSPACE", targetType: anchored ? "TASK" : null, targetId: anchored ? "task" : null, updatedAt: new Date("2026-11-18T00:00:00Z"), _count: { messages: 1 } })

beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: "user" } })
  mocks.membership.mockResolvedValue({ userId: "user" })
  mocks.links.mockResolvedValue([])
  mocks.rows.mockResolvedValue([])
  mocks.backfill.mockResolvedValue(undefined)
})

describe("object conversations list", () => {
  it("intersects the complete owner/shared/participant predicate with object selection", async () => {
    await GET(request())
    expect(mocks.rows).toHaveBeenCalledWith(expect.objectContaining({ where: {
      archivedAt: null,
      AND: [accessibleConversationsWhere("workspace", "user"), { OR: [{ targetType: "TASK", targetId: "task" }] }],
    } }))
  })
  it("returns anchor and all link provenance without duplicating overlapping rows", async () => {
    mocks.rows.mockResolvedValue([row("anchored", true), row("overlap", true), row("linked")])
    mocks.links.mockResolvedValue([
      { conversationId: "overlap", linkId: "overlap-link", kind: "CREATED", auto: true },
      { conversationId: "linked", linkId: "manual-link", kind: "MENTIONS", auto: false },
      { conversationId: "linked", linkId: "auto-link", kind: "CREATED", auto: true },
    ])
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect((await response.json()).items).toMatchObject([
      { id: "anchored", anchored: true, links: [] },
      { id: "overlap", anchored: true, links: [{ linkId: "overlap-link", kind: "CREATED", auto: true }] },
      { id: "linked", anchored: false, links: [{ linkId: "manual-link", kind: "MENTIONS", auto: false }, { linkId: "auto-link", kind: "CREATED", auto: true }] },
    ])
  })

  it.each(["links", "rows"] as const)("returns an error instead of a false empty or partial list when %s fails", async (source) => {
    mocks[source].mockRejectedValue(new Error("database unavailable"))
    const response = await GET(request())
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: "Could not load conversations. Please try again." })
  })

  it("does not read links or conversation titles for a nonmember", async () => {
    mocks.membership.mockResolvedValue(null)
    expect((await GET(request())).status).toBe(404)
    expect(mocks.links).not.toHaveBeenCalled()
    expect(mocks.rows).not.toHaveBeenCalled()
  })

  it("uses the compatibility read only for a known missing conversation column", async () => {
    mocks.links.mockResolvedValue([{ conversationId: "linked", linkId: "link", kind: "CREATED", auto: true }])
    mocks.rows.mockRejectedValueOnce({ code: "P2022", meta: { modelName: "AgentConversation", column: "agent_conversations.target_type" } }).mockResolvedValueOnce([row("linked")])
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect((await response.json()).items[0]).toMatchObject({ anchored: false, links: [{ linkId: "link", kind: "CREATED", auto: true }] })
  })

  it("never treats a linked lookup's missing column as an empty successful list", async () => {
    mocks.links.mockRejectedValue({ code: "P2022", meta: { modelName: "AgentConversation", column: "agent_conversations.target_type" } })
    expect((await GET(request())).status).toBe(503)
    expect(mocks.rows).not.toHaveBeenCalled()
  })

  it("returns 503 when the compatibility read also fails", async () => {
    mocks.links.mockResolvedValue([{ conversationId: "linked", linkId: "link", kind: "CREATED", auto: true }])
    mocks.rows.mockRejectedValueOnce({ code: "P2022", meta: { modelName: "AgentConversation", column: "agent_conversations.target_type" } }).mockRejectedValueOnce(new Error("database unavailable"))
    expect((await GET(request())).status).toBe(503)
  })
})
