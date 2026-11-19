import { beforeEach, describe, expect, it, vi } from "vitest"

const tx = {
  comment: { findUnique: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn(), delete: vi.fn() },
  docCommentAnchor: { deleteMany: vi.fn() },
  // A widget-submitted comment carries these two. relationMode="prisma" emulates
  // `onDelete: Restrict`, so either one left behind turns the delete into a 500.
  commentElementAnchor: { deleteMany: vi.fn() },
  commentExternalAuthor: { deleteMany: vi.fn() },
  // COMMENT task links are TASK_CREATED_FROM rows in entity_links.
  entityLink: { findMany: vi.fn(), deleteMany: vi.fn() },
}
const runTransaction = async (operation: (client: typeof tx) => unknown, options?: { isolationLevel: string }) => {
  // Match production DSQL rather than silently accepting PostgreSQL-only modes.
  if (options?.isolationLevel !== "RepeatableRead") {
    throw Object.assign(new Error("Unsupported isolation level: SERIALIZABLE"), { code: "0A000" })
  }
  return operation(tx)
}
const transaction = vi.fn(runTransaction)
vi.mock("@/lib/db", () => ({ default: () => ({ $transaction: transaction }) }))
vi.mock("@/auth", () => ({ auth: vi.fn() }))
const mirror = vi.hoisted(() => ({ removeCommentMirrorAfterCommit: vi.fn() }))
vi.mock("@/lib/conversation-mirror", () => mirror)

import { deleteBrowserComment, CommentHttpError } from "@/lib/comment-browser"

beforeEach(() => {
  vi.clearAllMocks()
  mirror.removeCommentMirrorAfterCommit.mockResolvedValue(undefined)
  transaction.mockImplementation(runTransaction)
  tx.comment.findMany.mockResolvedValue([])
  tx.comment.deleteMany.mockResolvedValue({ count: 0 })
  tx.comment.delete.mockResolvedValue({ id: "root-1" })
  tx.docCommentAnchor.deleteMany.mockResolvedValue({ count: 0 })
  tx.commentElementAnchor.deleteMany.mockResolvedValue({ count: 0 })
  tx.commentExternalAuthor.deleteMany.mockResolvedValue({ count: 0 })
  tx.entityLink.findMany.mockResolvedValue([])
  tx.entityLink.deleteMany.mockResolvedValue({ count: 0 })
})

describe("atomic browser comment deletion", () => {
  it("deletes an author's standalone comment using DSQL-supported isolation", async () => {
    tx.comment.findUnique.mockResolvedValue({ id: "root-1", parentId: null, authorId: "user-1", solutionPlanProposal: null, _count: { replies: 0 } })

    await expect(deleteBrowserComment("root-1", { userId: "user-1", admin: false }, false))
      .resolves.toEqual({ id: "root-1", deletedReplies: 0 })
    expect(tx.comment.delete).toHaveBeenCalledWith({ where: { id: "root-1" } })
    expect(transaction).toHaveBeenCalledTimes(1)
  })

  it("removes the mirrored conversation after the delete commits (no ghost mirror)", async () => {
    tx.comment.findUnique.mockResolvedValue({ id: "root-1", parentId: null, authorId: "admin-1", solutionPlanProposal: null, _count: { replies: 1 } })
    tx.comment.findMany.mockResolvedValue([{ id: "reply-1" }])
    let committed = false
    transaction.mockImplementation(async (op: Parameters<typeof runTransaction>[0], options?: { isolationLevel: string }) => { const out = await runTransaction(op, options); committed = true; return out })
    mirror.removeCommentMirrorAfterCommit.mockImplementation(async () => { expect(committed).toBe(true) })
    await deleteBrowserComment("root-1", { userId: "admin-1", admin: true }, true)
    expect(mirror.removeCommentMirrorAfterCommit).toHaveBeenCalledWith({ conversationId: "root-1", commentIds: ["reply-1", "root-1"], threadDeleted: true })
  })

  it("removes only the reply's mirror message when a reply is deleted, and nothing when the delete is refused", async () => {
    tx.comment.findUnique.mockResolvedValue({ id: "reply-1", parentId: "root-1", authorId: "user-1", solutionPlanProposal: null, _count: { replies: 0 } })
    await deleteBrowserComment("reply-1", { userId: "user-1", admin: false }, false)
    expect(mirror.removeCommentMirrorAfterCommit).toHaveBeenCalledWith({ conversationId: "root-1", commentIds: ["reply-1"], threadDeleted: false })
    mirror.removeCommentMirrorAfterCommit.mockClear()
    tx.comment.findUnique.mockResolvedValue({ id: "root-1", parentId: null, authorId: "user-1", solutionPlanProposal: null, _count: { replies: 1 } })
    await expect(deleteBrowserComment("root-1", { userId: "user-1", admin: false }, false)).rejects.toMatchObject({ status: 409 })
    expect(mirror.removeCommentMirrorAfterCommit).not.toHaveBeenCalled()
  })

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
    // Every extension row for the whole thread goes first, in the same
    // transaction. Missing one would make the emulated Restrict reject the
    // delete and surface as a 500 to whoever clicked it.
    for (const model of [tx.docCommentAnchor, tx.commentElementAnchor, tx.commentExternalAuthor]) {
      expect(model.deleteMany).toHaveBeenCalledWith({ where: { commentId: { in: ["reply-1", "root-1"] } } })
    }
    // Tasks made from the thread keep living; only their COMMENT links go (entity_links is the only store).
    expect(tx.entityLink.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { OR: [{ fromType: "COMMENT", fromId: { in: ["reply-1", "root-1"] } }, { toType: "COMMENT", toId: { in: ["reply-1", "root-1"] } }] },
    }))
  })

  it("never permits generic deletion of a specialized plan row", async () => {
    tx.comment.findUnique.mockResolvedValue({ id: "plan-1", parentId: null, authorId: "user-1", solutionPlanProposal: { commentId: "plan-1" }, _count: { replies: 0 } })
    await expect(deleteBrowserComment("plan-1", { userId: "user-1", admin: true }, true)).rejects.toMatchObject({ status: 404 })
    expect(tx.comment.delete).not.toHaveBeenCalled()
  })

  it("retries a DSQL write conflict with supported isolation", async () => {
    transaction
      .mockRejectedValueOnce(Object.assign(new Error("serialization conflict"), { code: "P2034" }))
      .mockImplementationOnce(runTransaction)
    tx.comment.findUnique.mockResolvedValue({ id: "reply-1", parentId: "root-1", authorId: "user-1", solutionPlanProposal: null, _count: { replies: 0 } })

    await expect(deleteBrowserComment("reply-1", { userId: "user-1", admin: false }, false)).resolves.toMatchObject({ id: "reply-1" })
    expect(transaction).toHaveBeenCalledTimes(2)
    expect(transaction.mock.calls[1][1]).toEqual({ isolationLevel: "RepeatableRead" })
  })
})
