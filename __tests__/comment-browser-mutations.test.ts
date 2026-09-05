import { beforeEach, describe, expect, it, vi } from "vitest"

const tx = {
  comment: { findUnique: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn(), delete: vi.fn() },
  docCommentAnchor: { deleteMany: vi.fn() },
}
const transaction = vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx))
vi.mock("@/lib/db", () => ({ default: () => ({ $transaction: transaction }) }))
vi.mock("@/auth", () => ({ auth: vi.fn() }))

import { deleteBrowserComment, CommentHttpError } from "@/lib/comment-browser"

beforeEach(() => {
  vi.clearAllMocks()
  tx.comment.findMany.mockResolvedValue([])
  tx.comment.deleteMany.mockResolvedValue({ count: 0 })
  tx.comment.delete.mockResolvedValue({ id: "root-1" })
  tx.docCommentAnchor.deleteMany.mockResolvedValue({ count: 0 })
})

describe("atomic browser comment deletion", () => {
  it("rechecks replies inside the transaction and blocks an author after a concurrent reply arrives", async () => {
    tx.comment.findUnique.mockResolvedValue({ id: "root-1", parentId: null, authorId: "user-1", solutionPlanProposal: null, _count: { replies: 1 } })

    await expect(deleteBrowserComment("root-1", { userId: "user-1", admin: false }, false))
      .rejects.toEqual(new CommentHttpError(409, "Admin confirmation is required to delete a thread with replies."))
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(tx.comment.delete).not.toHaveBeenCalled()
  })

  it("allows only an explicitly confirmed admin to delete the root and replies in one transaction", async () => {
    tx.comment.findUnique.mockResolvedValue({ id: "root-1", parentId: null, authorId: "user-1", solutionPlanProposal: null, _count: { replies: 1 } })
    tx.comment.findMany.mockResolvedValue([{ id: "reply-1" }])

    await expect(deleteBrowserComment("root-1", { userId: "admin-1", admin: true }, true))
      .resolves.toEqual({ id: "root-1", deletedReplies: 1 })
    expect(tx.comment.deleteMany).toHaveBeenCalledWith({ where: { parentId: "root-1" } })
    expect(tx.comment.delete).toHaveBeenCalledWith({ where: { id: "root-1" } })
  })

  it("never permits generic deletion of a specialized plan row", async () => {
    tx.comment.findUnique.mockResolvedValue({ id: "plan-1", parentId: null, authorId: "user-1", solutionPlanProposal: { commentId: "plan-1" }, _count: { replies: 0 } })
    await expect(deleteBrowserComment("plan-1", { userId: "user-1", admin: true }, true)).rejects.toMatchObject({ status: 404 })
    expect(tx.comment.delete).not.toHaveBeenCalled()
  })
})
