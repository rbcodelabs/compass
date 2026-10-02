import { beforeEach, describe, expect, it, vi } from "vitest"

const state = { legacyBody: "before", sharedBody: "before", legacyStatus: "OPEN", sharedStatus: "OPEN", legacyExists: true, sharedExists: true }
const mocks = vi.hoisted(() => ({
  failSharedUpdate: { value: false },
  failLegacyDelete: { value: false },
  tx: {
    docComment: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), deleteMany: vi.fn(), delete: vi.fn() },
    comment: { findMany: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    docCommentAnchor: { deleteMany: vi.fn() }, solutionPlanProposal: { deleteMany: vi.fn() },
    commentElementAnchor: { deleteMany: vi.fn() }, commentExternalAuthor: { deleteMany: vi.fn() },
  },
  db: { $transaction: vi.fn() },
}))

vi.mock("@/lib/db", () => ({ default: () => mocks.db }))
vi.mock("@/lib/comment-authors", () => ({ resolveCommentAuthors: async (rows: unknown[]) => rows }))

describe("legacy/shared Doc comment atomic compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(state, { legacyBody: "before", sharedBody: "before", legacyStatus: "OPEN", sharedStatus: "OPEN", legacyExists: true, sharedExists: true })
    mocks.failSharedUpdate.value = false
    mocks.failLegacyDelete.value = false
    mocks.tx.docComment.findUnique.mockResolvedValue({ id: "comment-1", parentId: null })
    mocks.tx.docComment.findMany.mockResolvedValue([{ id: "reply-1" }])
    mocks.tx.comment.findMany.mockResolvedValue([{ id: "reply-1" }])
    mocks.tx.docComment.update.mockImplementation(async ({ data }: { data: { body?: string; status?: string } }) => {
      if (data.body) state.legacyBody = data.body
      if (data.status) state.legacyStatus = data.status
      return { id: "comment-1", body: state.legacyBody, status: state.legacyStatus, parentId: null }
    })
    mocks.tx.comment.updateMany.mockImplementation(async ({ data }: { data: { body?: string; status?: string } }) => {
      if (mocks.failSharedUpdate.value) throw new Error("shared update failed")
      if (data.body) state.sharedBody = data.body
      if (data.status) state.sharedStatus = data.status
      return { count: 1 }
    })
    mocks.tx.docComment.deleteMany.mockImplementation(async () => { state.legacyExists = false; return { count: 1 } })
    mocks.tx.docComment.delete.mockImplementation(async () => {
      if (mocks.failLegacyDelete.value) throw new Error("legacy delete failed")
      state.legacyExists = false
    })
    mocks.tx.comment.deleteMany.mockImplementation(async () => {
      state.sharedExists = false
      return { count: 1 }
    })
    mocks.db.$transaction.mockImplementation(async (fn: (tx: typeof mocks.tx) => Promise<unknown>) => {
      const snapshot = { ...state }
      try { return await fn(mocks.tx) } catch (error) { Object.assign(state, snapshot); throw error }
    })
  })

  it("rolls back the legacy body when the shared mirror update fails", async () => {
    const { updateDocCommentBodyCore } = await import("@/lib/doc-comments")
    mocks.failSharedUpdate.value = true
    await expect(updateDocCommentBodyCore("comment-1", "after")).rejects.toThrow("shared update failed")
    expect(state).toMatchObject({ legacyBody: "before", sharedBody: "before" })
  })

  it("rolls back root and reply mirror deletion when the legacy delete fails", async () => {
    const { deleteDocCommentCore } = await import("@/lib/doc-comments")
    mocks.failLegacyDelete.value = true
    await expect(deleteDocCommentCore("comment-1")).rejects.toThrow("legacy delete failed")
    expect(state).toMatchObject({ legacyExists: true, sharedExists: true })
  })

  it("rolls back the legacy status when the shared mirror update fails", async () => {
    const { setDocCommentStatusCore } = await import("@/lib/doc-comments")
    mocks.failSharedUpdate.value = true
    await expect(setDocCommentStatusCore("comment-1", "RESOLVED")).rejects.toThrow("shared update failed")
    expect(state).toMatchObject({ legacyStatus: "OPEN", sharedStatus: "OPEN" })
  })
})
