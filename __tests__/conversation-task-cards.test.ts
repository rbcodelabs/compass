// TASK-195 S4: the read side that puts task cards and the composer's task context on a conversation.
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ cards: vi.fn(), agents: vi.fn(), title: vi.fn() }))
vi.mock("@/lib/doc-comment-tasks", () => ({ loadCommentTaskCards: mocks.cards }))
vi.mock("@/lib/comment-target-tasks", () => ({ agentIdsAssignedOnTarget: mocks.agents, targetTitle: mocks.title }))

import { loadConversationTaskCards, loadTaskComposerContext } from "@/lib/conversation-task-cards"

const WS = "00000000-0000-4000-8000-000000000001"
const card = { taskId: "t1", displayId: "TASK-1", title: "Do it", status: "TODO", priority: "MEDIUM", dueDate: null, assignee: null }

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("loadConversationTaskCards", () => {
  it("keys a card by the message (comment) id it was created from", async () => {
    mocks.cards.mockResolvedValue({ m1: card })
    expect(await loadConversationTaskCards(WS, ["m1", "m2"])).toEqual({ m1: card })
    expect(mocks.cards).toHaveBeenCalledWith(WS, ["m1", "m2"])
  })

  it("asks nothing for an empty list", async () => {
    expect(await loadConversationTaskCards(WS, [])).toEqual({})
    expect(mocks.cards).not.toHaveBeenCalled()
  })

  it("never fails the conversation read: a lookup error is an empty map, logged without message text", async () => {
    mocks.cards.mockRejectedValue(new Error("secret body text from a private comment"))
    expect(await loadConversationTaskCards(WS, ["m1"])).toEqual({})
    expect(JSON.stringify((console.error as unknown as { mock: { calls: unknown[] } }).mock.calls)).not.toContain("secret body text")
  })
})

describe("loadTaskComposerContext", () => {
  it("returns the agents that already hold a task here and the item's title", async () => {
    mocks.agents.mockResolvedValue(["agent-1"])
    mocks.title.mockResolvedValue("Q4 launch")
    expect(await loadTaskComposerContext(WS, "ROADMAP_ITEM", "target")).toEqual({ confirmedAgentIds: ["agent-1"], targetTitle: "Q4 launch" })
    expect(mocks.agents).toHaveBeenCalledWith(WS, "ROADMAP_ITEM", "target")
  })

  it("is empty for a type that cannot carry comments, and for a Doc (Docs keep their own flow)", async () => {
    expect(await loadTaskComposerContext(WS, "SOMETHING_ELSE", "x")).toEqual({ confirmedAgentIds: [], targetTitle: null })
    expect(await loadTaskComposerContext(WS, "DOC", "x")).toEqual({ confirmedAgentIds: [], targetTitle: null })
    expect(mocks.agents).not.toHaveBeenCalled()
  })

  it("degrades each half independently when its lookup fails", async () => {
    mocks.agents.mockRejectedValue(new Error("boom"))
    mocks.title.mockResolvedValue("Kept title")
    expect(await loadTaskComposerContext(WS, "OPPORTUNITY", "x")).toEqual({ confirmedAgentIds: [], targetTitle: "Kept title" })
  })
})
