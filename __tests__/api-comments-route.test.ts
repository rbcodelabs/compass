import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const authorizeTarget = vi.fn()
const authorizeExisting = vi.fn()
const listComments = vi.fn()
const createComment = vi.fn()
const updateCommentBody = vi.fn()
const setCommentStatus = vi.fn()
const deleteComment = vi.fn()
const toCommentThreads = vi.fn()
const toCommentDto = vi.fn()

vi.mock("@/lib/comment-browser", () => ({
  CommentHttpError: class extends Error {
    constructor(public readonly status: number, message: string) { super(message) }
  },
  authorizeCommentTarget: (...args: unknown[]) => authorizeTarget(...args),
  authorizeComment: (...args: unknown[]) => authorizeExisting(...args),
  toCommentThreads: (...args: unknown[]) => toCommentThreads(...args),
  toCommentDto: (...args: unknown[]) => toCommentDto(...args),
}))
vi.mock("@/lib/comments", () => ({
  COMMENT_TARGET_TYPES: ["ROADMAP_ITEM", "REVIEW_REQUEST"],
  listComments: (...args: unknown[]) => listComments(...args),
  createComment: (...args: unknown[]) => createComment(...args),
  updateCommentBody: (...args: unknown[]) => updateCommentBody(...args),
  setCommentStatus: (...args: unknown[]) => setCommentStatus(...args),
  deleteComment: (...args: unknown[]) => deleteComment(...args),
}))

import { DELETE, PATCH } from "@/app/api/comments/[id]/route"
import { GET, POST } from "@/app/api/comments/route"

const actor = { userId: "user-1", name: "User", workspaceId: "workspace-1", admin: false }
const existing = {
  ...actor, owns: true,
  comment: { id: "comment-1", authorId: "user-1", targetType: "ROADMAP_ITEM", targetId: "target-1", workspaceId: "workspace-1", parentId: null, replyCount: 0 },
}
const request = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(`http://compass.test${path}`, init)

beforeEach(() => {
  vi.clearAllMocks()
  authorizeTarget.mockResolvedValue(actor)
  authorizeExisting.mockResolvedValue(existing)
  listComments.mockResolvedValue([])
  createComment.mockResolvedValue({ id: "comment-1" })
  updateCommentBody.mockResolvedValue({ id: "comment-1", body: "Edited" })
  setCommentStatus.mockResolvedValue({ id: "comment-1", status: "RESOLVED" })
  deleteComment.mockResolvedValue({ id: "comment-1", deletedReplies: 0 })
  toCommentThreads.mockReturnValue([])
  toCommentDto.mockImplementation((row) => ({ ...row, replies: [] }))
})

describe("GET /api/comments", () => {
  it("rejects an unsupported target before authorization", async () => {
    const response = await GET(request("/api/comments?targetType=RELEASE_RUN&targetId=target-1"))
    expect(response.status).toBe(400)
    expect(authorizeTarget).not.toHaveBeenCalled()
  })

  it("preserves an authentication failure", async () => {
    authorizeTarget.mockRejectedValue(Object.assign(new Error("Unauthorized"), { status: 401 }))
    expect((await GET(request("/api/comments?targetType=ROADMAP_ITEM&targetId=target-1"))).status).toBe(401)
  })

  it("lists through the server-resolved workspace", async () => {
    listComments.mockResolvedValue([{ id: "comment-1" }])
    toCommentThreads.mockReturnValue([{ id: "comment-1", replies: [] }])
    const response = await GET(request("/api/comments?targetType=ROADMAP_ITEM&targetId=target-1&workspaceId=evil"))
    expect(response.status).toBe(200)
    expect(listComments).toHaveBeenCalledWith("workspace-1", "ROADMAP_ITEM", "target-1")
    expect(await response.json()).toEqual({ items: [{ id: "comment-1", replies: [] }] })
  })
})

describe("POST /api/comments", () => {
  it("uses the resolved workspace and human session snapshot", async () => {
    const response = await POST(request("/api/comments", { method: "POST", body: JSON.stringify({ targetType: "ROADMAP_ITEM", targetId: "target-1", workspaceId: "evil", parentId: "parent-1", body: "  Hello  " }) }))
    expect(response.status).toBe(201)
    expect(createComment).toHaveBeenCalledWith({ workspaceId: "workspace-1", targetType: "ROADMAP_ITEM", targetId: "target-1", parentId: "parent-1", body: "  Hello  ", authorId: "user-1", authorName: "User", authorType: "HUMAN", source: "UI" })
    expect(toCommentDto).toHaveBeenCalledWith({ id: "comment-1" }, actor)
  })

  it.each([
    [{ targetType: "ROADMAP_ITEM", targetId: "", body: "Hello" }, "targetId"],
    [{ targetType: "ROADMAP_ITEM", targetId: "target-1", body: "" }, "body"],
    [{ targetType: "ROADMAP_ITEM", targetId: "target-1", body: "Hello", parentId: 4 }, "parentId"],
  ])("rejects malformed input %j", async (body, expectedField) => {
    const response = await POST(request("/api/comments", { method: "POST", body: JSON.stringify(body) }))
    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain(expectedField)
    expect(createComment).not.toHaveBeenCalled()
  })
})

describe("PATCH /api/comments/[id]", () => {
  it("hides edit from a non-author member", async () => {
    authorizeExisting.mockResolvedValue({ ...existing, owns: false })
    const response = await PATCH(request("/api/comments/comment-1", { method: "PATCH", body: JSON.stringify({ action: "edit", body: "Edited" }) }), { params: Promise.resolve({ id: "comment-1" }) })
    expect(response.status).toBe(404)
    expect(updateCommentBody).not.toHaveBeenCalled()
  })

  it("allows an author to edit and returns a browser DTO", async () => {
    const response = await PATCH(request("/api/comments/comment-1", { method: "PATCH", body: JSON.stringify({ action: "edit", body: "Edited" }) }), { params: Promise.resolve({ id: "comment-1" }) })
    expect(response.status).toBe(200)
    expect(updateCommentBody).toHaveBeenCalledWith("comment-1", "Edited")
    expect(toCommentDto).toHaveBeenCalled()
  })

  it.each([["resolve", "RESOLVED"], ["reopen", "OPEN"]])("allows a participant to %s", async (action, status) => {
    authorizeExisting.mockResolvedValue({ ...existing, owns: false })
    const response = await PATCH(request("/api/comments/comment-1", { method: "PATCH", body: JSON.stringify({ action }) }), { params: Promise.resolve({ id: "comment-1" }) })
    expect(response.status).toBe(200)
    expect(setCommentStatus).toHaveBeenCalledWith("comment-1", status)
  })
})

describe("DELETE /api/comments/[id]", () => {
  it("hides deletion from a non-author member", async () => {
    authorizeExisting.mockResolvedValue({ ...existing, owns: false })
    const response = await DELETE(request("/api/comments/comment-1", { method: "DELETE" }), { params: Promise.resolve({ id: "comment-1" }) })
    expect(response.status).toBe(404)
  })

  it("prevents an author from deleting a root with replies", async () => {
    authorizeExisting.mockResolvedValue({ ...existing, comment: { ...existing.comment, replyCount: 2 } })
    const response = await DELETE(request("/api/comments/comment-1", { method: "DELETE" }), { params: Promise.resolve({ id: "comment-1" }) })
    expect(response.status).toBe(409)
    expect(deleteComment).not.toHaveBeenCalled()
  })

  it("requires explicit confirmation before an admin deletes a thread", async () => {
    authorizeExisting.mockResolvedValue({ ...existing, admin: true, owns: false, comment: { ...existing.comment, replyCount: 2 } })
    const unconfirmed = await DELETE(request("/api/comments/comment-1", { method: "DELETE" }), { params: Promise.resolve({ id: "comment-1" }) })
    const confirmed = await DELETE(request("/api/comments/comment-1?deleteThread=true", { method: "DELETE" }), { params: Promise.resolve({ id: "comment-1" }) })
    expect(unconfirmed.status).toBe(409)
    expect(confirmed.status).toBe(200)
    expect(deleteComment).toHaveBeenCalledTimes(1)
  })

  it("allows an author to delete a reply", async () => {
    authorizeExisting.mockResolvedValue({ ...existing, comment: { ...existing.comment, parentId: "root-1", replyCount: 0 } })
    const response = await DELETE(request("/api/comments/comment-1", { method: "DELETE" }), { params: Promise.resolve({ id: "comment-1" }) })
    expect(response.status).toBe(200)
    expect(deleteComment).toHaveBeenCalledWith("comment-1")
  })
})
