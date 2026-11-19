/** TASK-195 S2: by-target returns archived rows only on request, and only the ones the caller may restore. */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), membership: vi.fn(), rows: vi.fn(), links: vi.fn(), backfill: vi.fn(), restorable: vi.fn(),
}))
vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("@/lib/db", () => ({ default: () => ({ workspaceMember: { findFirst: mocks.membership }, agentConversation: { findMany: mocks.rows } }) }))
vi.mock("@/lib/links/conversation-links", () => ({ isConversationLinkTarget: () => true, listConversationsForObject: mocks.links }))
vi.mock("@/lib/doc-comment-tasks", () => ({ loadMentionCandidates: async () => ({ people: [], agents: [], outside: [] }) }))
vi.mock("@/lib/unified-conversations-backfill", () => ({ backfillUnifiedConversations: mocks.backfill }))
vi.mock("@/lib/conversation-archive", () => ({ listRestorableArchivedConversations: mocks.restorable }))
import { GET } from "@/app/api/agent/conversations/by-target/route"

const request = (extra = "") => new NextRequest(`http://localhost/api/agent/conversations/by-target?workspaceId=workspace&targetType=TASK&targetId=task${extra}`)
const archivedRow = (id: string) => ({ id, title: `Secret title ${id}`, summary: "Secret summary", status: "OPEN", agentMode: "MENTION_ONLY", visibility: "WORKSPACE", targetType: "TASK", targetId: "task", updatedAt: new Date("2026-11-18T00:00:00Z"), _count: { messages: 4 } })

beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: "user" } })
  mocks.membership.mockResolvedValue({ userId: "user" })
  mocks.links.mockResolvedValue([])
  mocks.rows.mockResolvedValue([])
  mocks.backfill.mockResolvedValue(undefined)
  mocks.restorable.mockResolvedValue({ rows: [], capped: false })
})

describe("by-target archived rows", () => {
  it("excludes archived rows by default and never consults the restore listing", async () => {
    await GET(request())
    expect(mocks.rows).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ archivedAt: null }) }))
    expect(mocks.restorable).not.toHaveBeenCalled()
  })

  it("returns archived rows on request, flagged archived and restorable", async () => {
    mocks.restorable.mockResolvedValue({ rows: [archivedRow("a1")], capped: false })
    const body = await (await GET(request("&archived=1"))).json()
    expect(mocks.restorable).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace", userId: "user", targetType: "TASK", targetId: "task" }))
    expect(body.items).toMatchObject([{ id: "a1", archived: true, canRestore: true }])
    // An already-archived thread cannot be archived again.
    expect(body.items[0]).not.toHaveProperty("canArchive")
    expect(body.archivedCapped).toBe(false)
  })

  it("tells the client when the 50-row cap was reached", async () => {
    mocks.restorable.mockResolvedValue({ rows: [archivedRow("a1")], capped: true })
    expect((await (await GET(request("&archived=1"))).json()).archivedCapped).toBe(true)
  })

  it("does not leak archived titles or summaries when the caller may not restore any (empty listing)", async () => {
    mocks.restorable.mockResolvedValue({ rows: [], capped: false })
    const response = await GET(request("&archived=1"))
    const text = await response.text()
    expect(JSON.parse(text).items).toEqual([])
    expect(text).not.toContain("Secret")
  })

  it("keeps a nonmember out with 404 even when archived is requested", async () => {
    mocks.membership.mockResolvedValue(null)
    expect((await GET(request("&archived=1"))).status).toBe(404)
    expect(mocks.restorable).not.toHaveBeenCalled()
  })

  it("fails closed with 503 when the restore listing errors", async () => {
    mocks.restorable.mockRejectedValue(new Error("boom"))
    expect((await GET(request("&archived=1"))).status).toBe(503)
  })
})
