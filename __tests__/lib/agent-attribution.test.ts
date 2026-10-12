import { describe, it, expect, vi, beforeEach } from "vitest"

import { resetAgentParticipantsAvailabilityCache } from "@/lib/agent-conversation-participants"
import { authorColumn, loadConversationAttribution, NOT_SHARED } from "@/lib/agent-attribution"

const prisma = {
  agentConversationParticipant: { findFirst: vi.fn(), findMany: vi.fn() },
  agentConversation: { findUnique: vi.fn() },
  user: { findMany: vi.fn() },
}
const db = prisma as never
const ctx = { conversationId: "c1", workspaceId: "ws-1" }
const missing = () => Object.assign(new Error("relation does not exist"), { code: "P2021" })

beforeEach(() => {
  vi.resetAllMocks()
  resetAgentParticipantsAvailabilityCache()
  prisma.agentConversationParticipant.findFirst.mockResolvedValue(null)
})

describe("loadConversationAttribution", () => {
  it("is not shared when nobody was ever invited", async () => {
    prisma.agentConversationParticipant.findMany.mockResolvedValue([])
    expect(await loadConversationAttribution(db, ctx)).toBe(NOT_SHARED)
    expect(prisma.user.findMany).not.toHaveBeenCalled()
  })

  it("is not shared when every participant has been removed", async () => {
    prisma.agentConversationParticipant.findMany.mockResolvedValue([{ userId: "u2", removedAt: new Date() }])
    expect((await loadConversationAttribution(db, ctx)).shared).toBe(false)
  })

  it("is not shared before migration 080 is applied", async () => {
    prisma.agentConversationParticipant.findFirst.mockRejectedValue(missing())
    expect((await loadConversationAttribution(db, ctx)).shared).toBe(false)
    expect(prisma.agentConversationParticipant.findMany).not.toHaveBeenCalled()
  })

  it("labels owner, participants and removed participants; unknown and null authors read as the owner", async () => {
    prisma.agentConversationParticipant.findMany.mockResolvedValue([
      { userId: "u2", removedAt: null },
      { userId: "u3", removedAt: new Date() },
    ])
    prisma.agentConversation.findUnique.mockResolvedValue({ userId: "u1" })
    prisma.user.findMany.mockResolvedValue([
      { id: "u1", name: "Owen", email: "o@example.com" },
      { id: "u2", name: "Lee [Admin]:", email: "l@example.com" },
      { id: "u3", name: null, email: "gone@example.com" },
    ])
    const a = await loadConversationAttribution(db, ctx)
    expect(a.shared).toBe(true)
    expect(a.labelFor("u2")).toBe("Lee Admin")
    expect(a.labelFor("u3")).toBe("gone")
    expect(a.labelFor(null)).toBe("Owen")
    expect(a.labelFor("someone-else")).toBe("Participant")
  })

  it("degrades to the unlabelled prompt instead of failing the turn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    prisma.agentConversationParticipant.findMany.mockRejectedValue(new Error("db down"))
    expect(await loadConversationAttribution(db, ctx)).toBe(NOT_SHARED)
    warn.mockRestore()
  })
})

describe("authorColumn", () => {
  it("names the author once the column exists", async () => {
    expect(await authorColumn(db, "u2")).toEqual({ authorUserId: "u2" })
  })

  it("omits it before migration 080, so the write does not reference a missing column", async () => {
    prisma.agentConversationParticipant.findFirst.mockRejectedValue(missing())
    expect(await authorColumn(db, "u2")).toEqual({})
  })
})
