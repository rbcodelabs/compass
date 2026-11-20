// TASK-195 S4: what the conversation panel keeps from GET /messages. Everything the server computed for the signed-in
// person (edit capability, edited time) and the task cards must reach AgentChat on the FIRST load, not only after a poll.
import { describe, expect, it } from "vitest"
import { parseConversationMessagesResponse, parseTaskCards } from "@/lib/conversation-panel-messages"

const card = { taskId: "task-9", displayId: "TASK-9", title: "Draft the rollout", status: "TODO", priority: "HIGH", dueDate: null, assignee: null }
const full = { id: "m1", role: "user", content: "hi", createdAt: "2026-11-19T10:00:00.000Z", authorUserId: "u2", authorName: "Lee", editedAt: "2026-11-19T10:02:00.000Z", authorType: "HUMAN", messageKind: "COMMENT", canEdit: true, canDelete: false }

describe("parseConversationMessagesResponse", () => {
  it("keeps the capability fields and edit time, and the task cards keyed by message id", () => {
    const parsed = parseConversationMessagesResponse({ messages: [full], taskCards: { m1: card } })
    expect(parsed?.messages[0]).toEqual(full)
    expect(parsed?.taskCards).toEqual({ m1: card })
  })

  it("maps unknown roles to user, drops rows without an id or text, and ignores wrongly typed extras", () => {
    const parsed = parseConversationMessagesResponse({ messages: [{ ...full, role: "tool" }, { id: 4, content: "x" }, { id: "m2" }, { ...full, id: "m3", canEdit: "yes", editedAt: 5 }], taskCards: [] })
    expect(parsed?.messages.map((m) => [m.id, m.role])).toEqual([["m1", "user"], ["m3", "user"]])
    expect(parsed?.messages[1]).not.toHaveProperty("canEdit")
    expect(parsed?.messages[1]).not.toHaveProperty("editedAt")
    expect(parsed?.taskCards).toEqual({})
  })

  it("returns null for a body that is not a message list", () => {
    expect(parseConversationMessagesResponse({})).toBeNull()
    expect(parseConversationMessagesResponse(null)).toBeNull()
  })
})

describe("parseTaskCards validation", () => {
  const good = { taskId: "t", displayId: "TASK-1", title: "T", status: "TODO", priority: "HIGH", dueDate: null, assignee: { type: "USER", id: "u", displayName: "Q", available: true } }
  it("keeps a well-formed card and strips unknown fields", () => {
    expect(parseTaskCards({ m1: { ...good, secret: "x" } })).toEqual({ m1: good })
  })
  it.each([
    ["no status", { ...good, status: undefined }], ["unknown status", { ...good, status: "WEIRD" }], ["unknown priority", { ...good, priority: "SOON" }],
    ["bad displayId", { ...good, displayId: 4 }], ["bad dueDate", { ...good, dueDate: 4 }], ["assignee without name", { ...good, assignee: { type: "USER", id: "u", available: true } }],
    ["unknown assignee type", { ...good, assignee: { type: "BOT", id: "u", displayName: "Q", available: true } }],
  ])("drops a card with %s", (_name, card) => {
    expect(parseTaskCards({ m1: card })).toEqual({})
  })
})
