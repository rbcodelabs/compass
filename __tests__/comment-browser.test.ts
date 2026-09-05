import { beforeEach, describe, expect, it, vi } from "vitest"

const auth = vi.fn()
const resolveCommentTarget = vi.fn()
const workspaceFindUnique = vi.fn()
const commentFindUnique = vi.fn()
const commentFindMany = vi.fn()
const transaction = vi.fn()
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => auth(...args) }))
vi.mock("@/lib/comments", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/comments")>()
  return { ...original, resolveCommentTarget: (...args: unknown[]) => resolveCommentTarget(...args) }
})
vi.mock("@/lib/db", () => ({ default: () => ({ workspace: { findUnique: workspaceFindUnique }, comment: { findUnique: commentFindUnique, findMany: commentFindMany }, $transaction: transaction }) }))

import { authorizeComment, authorizeCommentTarget, CommentHttpError, listBrowserComments, toCommentDto, toCommentThreads, type BrowserCommentRow } from "@/lib/comment-browser"

const actor = { userId: "user-1", name: "Rick", workspaceId: "workspace-1", admin: false }
const createdAt = new Date("2026-09-04T12:00:00.000Z")
function row(overrides: Partial<BrowserCommentRow> = {}): BrowserCommentRow {
  return { id: "comment-1", workspaceId: "workspace-1", targetType: "ROADMAP_ITEM", targetId: "target-1", parentId: null, body: "Comment", status: "OPEN", authorId: "user-1", authorName: "Rick", authorType: "HUMAN", source: "UI", createdAt, updatedAt: createdAt, docAnchor: null, solutionPlanProposal: null, ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  auth.mockResolvedValue({ user: { id: "user-1", name: "Rick" } })
  resolveCommentTarget.mockResolvedValue({ workspaceId: "workspace-1" })
  workspaceFindUnique.mockResolvedValue({ members: [{ role: "MEMBER" }], organization: { members: [] } })
  commentFindMany.mockResolvedValue([])
})

describe("authorizeCommentTarget", () => {
  it("returns 401 without target lookup when signed out", async () => {
    auth.mockResolvedValue(null)
    await expect(authorizeCommentTarget("ROADMAP_ITEM", "target-1")).rejects.toMatchObject({ status: 401 })
    expect(resolveCommentTarget).not.toHaveBeenCalled()
  })
  it("hides a missing or non-commentable target as 404", async () => {
    resolveCommentTarget.mockResolvedValue(null)
    await expect(authorizeCommentTarget("REVIEW_REQUEST", "legacy-review")).rejects.toMatchObject({ status: 404 })
  })
  it("allows a workspace member", async () => {
    await expect(authorizeCommentTarget("ROADMAP_ITEM", "target-1")).resolves.toEqual(actor)
  })
  it.each(["OWNER", "ADMIN"])("allows an inherited organization %s", async (role) => {
    workspaceFindUnique.mockResolvedValue({ members: [], organization: { members: [{ role }] } })
    await expect(authorizeCommentTarget("ROADMAP_ITEM", "target-1")).resolves.toMatchObject({ admin: true })
  })
  it("hides the target from a non-member", async () => {
    workspaceFindUnique.mockResolvedValue({ members: [], organization: { members: [{ role: "MEMBER" }] } })
    await expect(authorizeCommentTarget("ROADMAP_ITEM", "target-1")).rejects.toMatchObject({ status: 404 })
  })
  it("normalizes workspace admin roles", async () => {
    workspaceFindUnique.mockResolvedValue({ members: [{ role: "owner" }], organization: { members: [] } })
    await expect(authorizeCommentTarget("ROADMAP_ITEM", "target-1")).resolves.toMatchObject({ admin: true })
  })
})

describe("authorizeComment", () => {
  it("hides a cross-workspace comment", async () => {
    commentFindUnique.mockResolvedValue({ authorId: "user-1", targetType: "ROADMAP_ITEM", targetId: "target-1", workspaceId: "other-workspace", parentId: null, solutionPlanProposal: null, _count: { replies: 0 } })
    await expect(authorizeComment("comment-1")).rejects.toMatchObject({ status: 404 })
  })
  it("marks a human author as owner and exposes reply count", async () => {
    commentFindUnique.mockResolvedValue({ authorId: "user-1", targetType: "ROADMAP_ITEM", targetId: "target-1", workspaceId: "workspace-1", parentId: null, solutionPlanProposal: null, _count: { replies: 2 } })
    await expect(authorizeComment("comment-1")).resolves.toMatchObject({ owns: true, comment: { replyCount: 2 } })
  })
  it("never treats a null author as owner", async () => {
    commentFindUnique.mockResolvedValue({ authorId: null, targetType: "ROADMAP_ITEM", targetId: "target-1", workspaceId: "workspace-1", parentId: null, solutionPlanProposal: null, _count: { replies: 0 } })
    await expect(authorizeComment("comment-1")).resolves.toMatchObject({ owns: false })
  })
})

describe("browser comment queries", () => {
  it("excludes specialized plan proposal rows from a Solution discussion at the database boundary", async () => {
    await listBrowserComments("workspace-1", "SOLUTION", "solution-1")
    expect(commentFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "workspace-1", targetType: "SOLUTION", targetId: "solution-1", solutionPlanProposal: { is: null } },
    }))
  })
})

describe("browser comment DTOs", () => {
  it("serializes timestamps and exposes author capabilities", () => {
    expect(toCommentDto(row({ updatedAt: new Date("2026-09-04T12:01:00.000Z") }), actor)).toMatchObject({ createdAt: "2026-09-04T12:00:00.000Z", updatedAt: "2026-09-04T12:01:00.000Z", edited: true, canEdit: true, canDelete: true, canModerate: true, replies: [] })
  })
  it("makes comments without an author id admin-only for edit and delete", () => {
    expect(toCommentDto(row({ authorId: null, authorType: "AGENT", source: "MCP" }), actor)).toMatchObject({ canEdit: false, canDelete: false, canModerate: true })
  })
  it("nests replies and disables author deletion on a replied-to root", () => {
    const threads = toCommentThreads([row(), row({ id: "reply-1", parentId: "comment-1" })], actor)
    expect(threads).toHaveLength(1)
    expect(threads[0]).toMatchObject({ id: "comment-1", canDelete: false })
    expect(threads[0].replies[0]).toMatchObject({ id: "reply-1", canDelete: true })
  })
  it("allows an admin to delete a replied-to root", () => {
    expect(toCommentThreads([row(), row({ id: "reply-1", parentId: "comment-1" })], { ...actor, admin: true })[0].canDelete).toBe(true)
  })
  it("retains typed extension payloads", () => {
    const result = toCommentDto(row({ docAnchor: { commentId: "comment-1", anchorText: "important", anchorPrefix: null, anchorSuffix: null, anchorStart: 1, anchorEnd: 10 } }), actor)
    expect(result.docAnchor?.anchorText).toBe("important")
  })
})

it("CommentHttpError carries a safe HTTP status", () => {
  expect(new CommentHttpError(404, "Not found")).toMatchObject({ status: 404, message: "Not found" })
})
