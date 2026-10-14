import { beforeEach, describe, expect, it, vi } from "vitest"

const state = { legacyBody: "before", sharedBody: "before", legacyStatus: "OPEN", sharedStatus: "OPEN", legacyExists: true, sharedExists: true, createdLegacy: false, createdShared: false }
const mocks = vi.hoisted(() => ({
  failSharedUpdate: { value: false },
  missingSharedUpdate: { value: false },
  failSharedCreate: { value: false },
  failLegacyDelete: { value: false },
  tx: {
    doc: { findUnique: vi.fn() },
    docComment: { create: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), deleteMany: vi.fn(), delete: vi.fn() },
    comment: { create: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    docCommentAnchor: { create: vi.fn(), deleteMany: vi.fn() }, solutionPlanProposal: { create: vi.fn(), deleteMany: vi.fn() },
    commentElementAnchor: { create: vi.fn(), deleteMany: vi.fn() }, commentExternalAuthor: { create: vi.fn(), deleteMany: vi.fn() },
  },
  db: { $transaction: vi.fn() },
}))

vi.mock("@/lib/db", () => ({ default: () => mocks.db }))
vi.mock("@/lib/comment-authors", () => ({ resolveCommentAuthors: async (rows: unknown[]) => rows }))

describe("legacy/shared Doc comment atomic compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(state, { legacyBody: "before", sharedBody: "before", legacyStatus: "OPEN", sharedStatus: "OPEN", legacyExists: true, sharedExists: true, createdLegacy: false, createdShared: false })
    mocks.failSharedUpdate.value = false
    mocks.missingSharedUpdate.value = false
    mocks.failSharedCreate.value = false
    mocks.failLegacyDelete.value = false
    mocks.tx.doc.findUnique.mockResolvedValue({ id: "doc-1", workspaceId: "workspace-1" })
    mocks.tx.docComment.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      state.createdLegacy = true
      return { id: "comment-new", createdAt: new Date(), updatedAt: new Date(), ...data }
    })
    mocks.tx.comment.create.mockImplementation(async () => {
      if (mocks.failSharedCreate.value) throw new Error("shared create failed")
      state.createdShared = true
      return { id: "comment-new" }
    })
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
      if (mocks.missingSharedUpdate.value) return { count: 0 }
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

  it("rolls back legacy creation when the shared mirror write fails", async () => {
    const { createDocCommentCore } = await import("@/lib/doc-comments")
    mocks.failSharedCreate.value = true
    await expect(createDocCommentCore({ docId: "doc-1", body: "new", authorName: "Alice" })).rejects.toThrow("shared create failed")
    expect(state).toMatchObject({ createdLegacy: false, createdShared: false })
  })

  it.each([
    ["body", async () => (await import("@/lib/doc-comments")).updateDocCommentBodyCore("comment-1", "after")],
    ["status", async () => (await import("@/lib/doc-comments")).setDocCommentStatusCore("comment-1", "RESOLVED")],
  ])("rolls back the legacy %s when its shared mirror is missing", async (_field, mutate) => {
    mocks.missingSharedUpdate.value = true
    await expect(mutate()).rejects.toThrow("mirror")
    expect(state).toMatchObject({ legacyBody: "before", legacyStatus: "OPEN" })
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
