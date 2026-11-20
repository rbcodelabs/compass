// TASK-195 S4: by-target carries what the section composer's task row needs, and a task card per conversation row.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({ auth: vi.fn(), membership: vi.fn(), rows: vi.fn(), cards: vi.fn(), context: vi.fn() }))
vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("@/lib/db", () => ({ default: () => ({ workspaceMember: { findFirst: mocks.membership }, agentConversation: { findMany: mocks.rows } }) }))
vi.mock("@/lib/links/conversation-links", () => ({ isConversationLinkTarget: () => true, listConversationsForObject: async () => [] }))
vi.mock("@/lib/doc-comment-tasks", () => ({ loadMentionCandidates: async () => ({ people: [], agents: [], outside: [] }) }))
vi.mock("@/lib/unified-conversations-backfill", () => ({ backfillUnifiedConversations: async () => undefined }))
vi.mock("@/lib/conversation-task-cards", () => ({ loadConversationTaskCards: mocks.cards, loadTaskComposerContext: mocks.context }))
import { GET } from "@/app/api/agent/conversations/by-target/route"

const request = () => new NextRequest("http://localhost/api/agent/conversations/by-target?workspaceId=workspace&targetType=ROADMAP_ITEM&targetId=item")
const row = (id: string) => ({ id, title: id, summary: null, status: "OPEN", agentMode: "MENTION_ONLY", visibility: "WORKSPACE", targetType: "ROADMAP_ITEM", targetId: "item", updatedAt: new Date("2026-11-19T00:00:00Z"), _count: { messages: 1 } })
const card = { taskId: "t1", displayId: "TASK-1", title: "Do it", status: "TODO", priority: "MEDIUM", dueDate: null, assignee: null }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: "user" } })
  mocks.membership.mockResolvedValue({ userId: "user" })
  mocks.rows.mockResolvedValue([row("with-task"), row("plain")])
  mocks.cards.mockResolvedValue({ "with-task": card })
  mocks.context.mockResolvedValue({ confirmedAgentIds: ["agent-1"], targetTitle: "Q4 launch" })
})

describe("by-target task row support", () => {
  it("adds confirmedAgentIds and targetTitle next to mentionOptions", async () => {
    const body = await (await GET(request())).json()
    expect(body.confirmedAgentIds).toEqual(["agent-1"])
    expect(body.targetTitle).toBe("Q4 launch")
    expect(body.mentionOptions).toBeDefined()
    expect(mocks.context).toHaveBeenCalledWith("workspace", "ROADMAP_ITEM", "item")
  })

  it("puts the root task card on its row only, looked up by the listed conversation ids", async () => {
    const body = await (await GET(request())).json()
    expect(mocks.cards).toHaveBeenCalledWith("workspace", ["with-task", "plain"])
    expect(body.items.find((item: { id: string }) => item.id === "with-task").taskCard).toEqual(card)
    expect(body.items.find((item: { id: string }) => item.id === "plain")).not.toHaveProperty("taskCard")
  })

  it("does not look anything up for a nonmember", async () => {
    mocks.membership.mockResolvedValue(null)
    expect((await GET(request())).status).toBe(404)
    expect(mocks.cards).not.toHaveBeenCalled()
    expect(mocks.context).not.toHaveBeenCalled()
  })
})
