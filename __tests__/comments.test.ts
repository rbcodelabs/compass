import { beforeEach, describe, expect, it, vi } from "vitest"

const prisma = {
  comment: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
  docCommentAnchor: { create: vi.fn(), deleteMany: vi.fn() },
  solutionPlanProposal: { create: vi.fn(), deleteMany: vi.fn() },
  opportunity: { findUnique: vi.fn() },
  solution: { findUnique: vi.fn() },
  reviewRequest: { findUnique: vi.fn() },
}
vi.mock("@/lib/db", () => ({ default: () => prisma }))

import { createComment, deleteComment, resolveCommentTarget } from "@/lib/comments"

const WS = "11111111-1111-1111-1111-111111111111"
const TARGET = "22222222-2222-2222-2222-222222222222"
const ROOT = "33333333-3333-3333-3333-333333333333"

beforeEach(() => vi.clearAllMocks())

describe("shared comment target registry", () => {
  it("resolves a nested Solution to its workspace", async () => {
    prisma.solution.findUnique.mockResolvedValue({ opportunity: { workspaceId: WS } })
    await expect(resolveCommentTarget("SOLUTION", TARGET)).resolves.toEqual({ workspaceId: WS })
  })

  it("allows only tracked ReviewRequest aggregates", async () => {
    prisma.reviewRequest.findUnique.mockResolvedValue({ workspaceId: WS, gateType: "RELEASE_AUTHORIZATION" })
    await expect(resolveCommentTarget("REVIEW_REQUEST", TARGET)).resolves.toBeNull()
  })
})

describe("createComment", () => {
  it("rejects a target outside the declared workspace", async () => {
    prisma.opportunity.findUnique.mockResolvedValue({ workspaceId: "44444444-4444-4444-4444-444444444444" })
    await expect(createComment({ workspaceId: WS, targetType: "OPPORTUNITY", targetId: TARGET, body: "hello", authorName: "Rick" }))
      .rejects.toThrow(/does not belong/)
  })

  it("rejects replies to replies", async () => {
    prisma.opportunity.findUnique.mockResolvedValue({ workspaceId: WS })
    prisma.comment.findUnique.mockResolvedValue({ id: ROOT, workspaceId: WS, targetType: "OPPORTUNITY", targetId: TARGET, parentId: "reply-parent" })
    await expect(createComment({ workspaceId: WS, targetType: "OPPORTUNITY", targetId: TARGET, parentId: ROOT, body: "nested", authorName: "Rick" }))
      .rejects.toThrow(/one level deep/)
  })

  it("rejects doc anchors on replies", async () => {
    prisma.comment.findUnique.mockResolvedValue({ id: ROOT, workspaceId: WS, targetType: "DOC", targetId: TARGET, parentId: null })
    await expect(createComment({ workspaceId: WS, targetType: "DOC", targetId: TARGET, parentId: ROOT, body: "reply", authorName: "Rick", docAnchor: { anchorText: "text" } }))
      .rejects.toThrow(/root Doc comments/)
  })
})

describe("deleteComment", () => {
  it("cleans extensions and replies before deleting a root", async () => {
    prisma.comment.findUnique.mockResolvedValue({ id: ROOT, parentId: null })
    prisma.comment.findMany.mockResolvedValue([{ id: "reply-1" }])
    prisma.docCommentAnchor.deleteMany.mockResolvedValue({ count: 1 })
    prisma.solutionPlanProposal.deleteMany.mockResolvedValue({ count: 0 })
    prisma.comment.deleteMany.mockResolvedValue({ count: 1 })
    prisma.comment.delete.mockResolvedValue({ id: ROOT })

    await deleteComment(ROOT)
    expect(prisma.docCommentAnchor.deleteMany).toHaveBeenCalledWith({ where: { commentId: { in: ["reply-1", ROOT] } } })
    expect(prisma.comment.deleteMany).toHaveBeenCalledWith({ where: { parentId: ROOT } })
    expect(prisma.comment.delete).toHaveBeenCalledWith({ where: { id: ROOT } })
  })
})
