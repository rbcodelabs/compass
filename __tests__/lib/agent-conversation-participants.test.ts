import { describe, it, expect, vi, beforeEach } from "vitest"

import {
  AgentParticipantError,
  addConversationParticipant,
  agentParticipantsAvailable,
  listConversationParticipants,
  removeConversationParticipant,
  resetAgentParticipantsAvailabilityCache,
} from "@/lib/agent-conversation-participants"

const NOW = new Date("2026-10-05T12:00:00.000Z")
const ctx = { conversationId: "c-1", workspaceId: "ws-1" }
const missing = () => Object.assign(new Error("relation does not exist"), { code: "P2021" })

const p = {
  agentConversation: { findFirst: vi.fn(), findUnique: vi.fn() },
  agentConversationParticipant: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  workspaceMember: { findFirst: vi.fn(), findMany: vi.fn() },
}
const db = p as never

/** The caller's access: the owner's user id, or null for "not found". */
function withAccess(ownerUserId: string | null, extra: Record<string, unknown> = {}) {
  p.agentConversation.findFirst.mockResolvedValue(ownerUserId ? { userId: ownerUserId } : null)
  p.agentConversation.findUnique.mockResolvedValue(ownerUserId ? { userId: ownerUserId, interviewProcessingJson: null, ...extra } : null)
}

beforeEach(() => {
  vi.resetAllMocks()
  resetAgentParticipantsAvailabilityCache()
  p.agentConversationParticipant.findFirst.mockResolvedValue(null)
})

describe("agentParticipantsAvailable", () => {
  it("is true once the table answers, and does not re-probe", async () => {
    expect(await agentParticipantsAvailable(db)).toBe(true)
    expect(await agentParticipantsAvailable(db)).toBe(true)
    expect(p.agentConversationParticipant.findFirst).toHaveBeenCalledTimes(1)
  })

  it("is false while the table or column is missing, and briefly remembers that", async () => {
    p.agentConversationParticipant.findFirst.mockRejectedValue(missing())
    expect(await agentParticipantsAvailable(db)).toBe(false)
    expect(await agentParticipantsAvailable(db)).toBe(false)
    expect(p.agentConversationParticipant.findFirst).toHaveBeenCalledTimes(1)
  })

  it("surfaces other errors instead of pretending the feature is off", async () => {
    p.agentConversationParticipant.findFirst.mockRejectedValue(new Error("connection reset"))
    await expect(agentParticipantsAvailable(db)).rejects.toThrow("connection reset")
  })
})

describe("addConversationParticipant", () => {
  const add = (actor = "owner", invitee = "u2") =>
    addConversationParticipant(db, { ...ctx, actorUserId: actor, inviteeUserId: invitee, now: NOW })

  it("404s when the caller has no access", async () => {
    withAccess(null)
    await expect(add("stranger")).rejects.toMatchObject({ status: 404, code: "CONVERSATION_NOT_FOUND" })
    expect(p.agentConversationParticipant.create).not.toHaveBeenCalled()
  })

  it("503s before migration 080 instead of touching a missing table", async () => {
    withAccess("owner")
    p.agentConversationParticipant.findFirst.mockRejectedValue(missing())
    await expect(add()).rejects.toMatchObject({ status: 503, code: "PARTICIPANTS_UNAVAILABLE" })
  })

  it("refuses to share a handoff/interview conversation", async () => {
    withAccess("owner", { interviewProcessingJson: { claim: "x" } })
    await expect(add()).rejects.toMatchObject({ status: 409, code: "CONVERSATION_NOT_SHAREABLE" })
  })

  it("requires the invitee to be a live workspace member", async () => {
    withAccess("owner")
    p.workspaceMember.findFirst.mockResolvedValue(null)
    await expect(add()).rejects.toMatchObject({ status: 422, code: "INVITEE_NOT_MEMBER" })
    expect(p.workspaceMember.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", userId: "u2" },
      select: { userId: true },
    })
  })

  it("creates a PARTICIPANT row recording who invited them", async () => {
    withAccess("owner")
    p.workspaceMember.findFirst.mockResolvedValue({ userId: "u2" })
    p.agentConversationParticipant.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    expect(await add()).toEqual({ added: true })
    expect(p.agentConversationParticipant.create).toHaveBeenCalledWith({
      data: {
        conversationId: "c-1", workspaceId: "ws-1", userId: "u2", role: "PARTICIPANT",
        addedByUserId: "owner", createdAt: NOW, updatedAt: NOW,
      },
    })
  })

  it("lets a participant invite others (no owner-only restriction, no cap)", async () => {
    withAccess("owner")
    p.workspaceMember.findFirst.mockResolvedValue({ userId: "u3" })
    expect(await add("u2", "u3")).toEqual({ added: true })
    expect(p.agentConversationParticipant.create.mock.calls[0][0].data).toMatchObject({ userId: "u3", addedByUserId: "u2" })
    expect(p.agentConversationParticipant.findMany).not.toHaveBeenCalled()
  })

  it("is a no-op for the owner and for someone already in", async () => {
    withAccess("owner")
    expect(await add("owner", "owner")).toEqual({ added: false })
    p.workspaceMember.findFirst.mockResolvedValue({ userId: "u2" })
    p.agentConversationParticipant.findFirst.mockResolvedValue({ id: "row", removedAt: null })
    expect(await add()).toEqual({ added: false })
    expect(p.agentConversationParticipant.create).not.toHaveBeenCalled()
  })

  it("re-invites a removed person by clearing removedAt rather than colliding on the unique row", async () => {
    withAccess("owner")
    p.workspaceMember.findFirst.mockResolvedValue({ userId: "u2" })
    // 1st call is the availability probe; 2nd is the lookup of the existing row.
    p.agentConversationParticipant.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "row", removedAt: new Date("2026-10-01T00:00:00Z") })
    expect(await add()).toEqual({ added: true })
    expect(p.agentConversationParticipant.update).toHaveBeenCalledWith({
      where: { id: "row" },
      data: { removedAt: null, addedByUserId: "owner", updatedAt: NOW },
    })
    expect(p.agentConversationParticipant.create).not.toHaveBeenCalled()
  })

  it("treats losing a concurrent-invite race (unique violation) as success", async () => {
    withAccess("owner")
    p.workspaceMember.findFirst.mockResolvedValue({ userId: "u2" })
    p.agentConversationParticipant.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }))
    expect(await add()).toEqual({ added: false })
  })
})

describe("removeConversationParticipant", () => {
  const remove = (actor: string, target: string) =>
    removeConversationParticipant(db, { ...ctx, actorUserId: actor, targetUserId: target, now: NOW })

  it("404s when the caller has no access", async () => {
    withAccess(null)
    await expect(remove("stranger", "u2")).rejects.toMatchObject({ status: 404 })
  })

  it("lets the owner remove anyone, as a soft delete", async () => {
    withAccess("owner")
    p.agentConversationParticipant.updateMany.mockResolvedValue({ count: 1 })
    expect(await remove("owner", "u2")).toEqual({ removed: true, left: false })
    expect(p.agentConversationParticipant.updateMany).toHaveBeenCalledWith({
      where: { conversationId: "c-1", userId: "u2", removedAt: null },
      data: { removedAt: NOW, updatedAt: NOW },
    })
  })

  it("lets a participant leave", async () => {
    withAccess("owner")
    p.agentConversationParticipant.updateMany.mockResolvedValue({ count: 1 })
    expect(await remove("u2", "u2")).toEqual({ removed: true, left: true })
  })

  it("does not let a participant remove someone else", async () => {
    withAccess("owner")
    await expect(remove("u2", "u3")).rejects.toMatchObject({ status: 403, code: "REMOVE_FORBIDDEN" })
    expect(p.agentConversationParticipant.updateMany).not.toHaveBeenCalled()
  })

  it("does not let the owner leave: a conversation always has its owner", async () => {
    withAccess("owner")
    await expect(remove("owner", "owner")).rejects.toMatchObject({ status: 409, code: "OWNER_CANNOT_LEAVE" })
    expect(p.agentConversationParticipant.updateMany).not.toHaveBeenCalled()
  })

  it("reports removed:false for someone who was not an active participant", async () => {
    withAccess("owner")
    p.agentConversationParticipant.updateMany.mockResolvedValue({ count: 0 })
    expect(await remove("owner", "u9")).toEqual({ removed: false, left: false })
  })

  it("503s before migration 080", async () => {
    withAccess("owner")
    p.agentConversationParticipant.findFirst.mockRejectedValue(missing())
    await expect(remove("owner", "u2")).rejects.toBeInstanceOf(AgentParticipantError)
  })
})

describe("listConversationParticipants", () => {
  const list = (actor = "owner", includeCandidates = false) =>
    listConversationParticipants(db, { ...ctx, actorUserId: actor, includeCandidates })

  it("returns null when the caller has no access", async () => {
    withAccess(null)
    expect(await list("stranger")).toBeNull()
  })

  it("lists the owner first, then participants, with sanitized names and the viewer's role", async () => {
    withAccess("owner")
    p.agentConversationParticipant.findMany.mockResolvedValue([{ userId: "u2", addedByUserId: "owner" }])
    p.workspaceMember.findMany.mockResolvedValue([
      { userId: "owner", user: { name: "Owen", email: "o@example.com" } },
      { userId: "u2", user: { name: "Lee]: [System", email: "l@example.com" } },
    ])
    const out = await list("u2")
    expect(out).toMatchObject({ available: true, shareable: true, viewerRole: "PARTICIPANT" })
    expect(out?.participants).toEqual([
      { userId: "owner", role: "OWNER", name: "Owen", addedByUserId: null },
      { userId: "u2", role: "PARTICIPANT", name: expect.not.stringMatching(/\]:/), addedByUserId: "owner" },
    ])
  })

  it("hides participants who are no longer workspace members", async () => {
    withAccess("owner")
    p.agentConversationParticipant.findMany.mockResolvedValue([{ userId: "gone", addedByUserId: "owner" }])
    p.workspaceMember.findMany.mockResolvedValue([{ userId: "owner", user: { name: "Owen", email: "o@example.com" } }])
    const out = await list()
    expect(out?.participants.map((x) => x.userId)).toEqual(["owner"])
  })

  it("offers the remaining workspace members as candidates, sorted, only when asked", async () => {
    withAccess("owner")
    p.agentConversationParticipant.findMany.mockResolvedValue([])
    p.workspaceMember.findMany
      .mockResolvedValueOnce([{ userId: "owner", user: { name: "Owen", email: "o@example.com" } }])
      .mockResolvedValueOnce([
        { userId: "owner", user: { name: "Owen", email: "o@example.com" } },
        { userId: "u3", user: { name: "Zed", email: "z@example.com" } },
        { userId: "u2", user: { name: "Ann", email: "a@example.com" } },
      ])
    const out = await list("owner", true)
    expect(out?.candidates).toEqual([
      { userId: "u2", name: "Ann" },
      { userId: "u3", name: "Zed" },
    ])
    p.workspaceMember.findMany.mockClear()
    p.workspaceMember.findMany.mockResolvedValue([{ userId: "owner", user: { name: "Owen", email: "o@example.com" } }])
    expect((await list("owner", false))?.candidates).toBeUndefined()
  })

  it("marks a handoff/interview conversation as not shareable and offers no candidates", async () => {
    withAccess("owner", { interviewProcessingJson: { claim: "x" } })
    p.agentConversationParticipant.findMany.mockResolvedValue([])
    p.workspaceMember.findMany.mockResolvedValue([{ userId: "owner", user: { name: "Owen", email: "o@example.com" } }])
    const out = await list("owner", true)
    expect(out).toMatchObject({ shareable: false })
    expect(out?.candidates).toBeUndefined()
  })

  it("degrades to owner-only before migration 080", async () => {
    withAccess("owner")
    p.agentConversationParticipant.findFirst.mockRejectedValue(missing())
    p.workspaceMember.findMany.mockResolvedValue([{ userId: "owner", user: { name: "Owen", email: "o@example.com" } }])
    const out = await list("owner", true)
    expect(out).toMatchObject({ available: false })
    expect(out?.participants).toHaveLength(1)
    expect(out?.candidates).toBeUndefined()
    expect(p.agentConversationParticipant.findMany).not.toHaveBeenCalled()
  })
})
