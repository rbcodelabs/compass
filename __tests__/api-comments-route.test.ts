import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const authorizeTarget = vi.fn()
const authorizeExisting = vi.fn()
const listBrowserComments = vi.fn()
const createComment = vi.fn()
const updateCommentBody = vi.fn()
const setCommentStatus = vi.fn()
const deleteBrowserComment = vi.fn()
const toCommentThreads = vi.fn()
const toCommentDto = vi.fn()

vi.mock("@/lib/comment-browser", () => ({
  CommentHttpError: class extends Error {
    constructor(public readonly status: number, message: string) { super(message) }
  },
  authorizeCommentTarget: (...args: unknown[]) => authorizeTarget(...args),
  authorizeComment: (...args: unknown[]) => authorizeExisting(...args),
  listBrowserComments: (...args: unknown[]) => listBrowserComments(...args),
  deleteBrowserComment: (...args: unknown[]) => deleteBrowserComment(...args),
  toCommentThreads: (...args: unknown[]) => toCommentThreads(...args),
  toCommentDto: (...args: unknown[]) => toCommentDto(...args),
}))
vi.mock("@/lib/comments", () => ({
  COMMENT_TARGET_TYPES: ["ROADMAP_ITEM", "REVIEW_REQUEST", "ARTIFACT"],
  createComment: (...args: unknown[]) => createComment(...args),
  updateCommentBody: (...args: unknown[]) => updateCommentBody(...args),
  setCommentStatus: (...args: unknown[]) => setCommentStatus(...args),
}))

import { DELETE, PATCH } from "@/app/api/comments/[id]/route"
import { GET, POST } from "@/app/api/comments/route"
import { CommentHttpError } from "@/lib/comment-browser"

const actor = { userId: "user-1", name: "User", workspaceId: "workspace-1", admin: false }
const existing = {
  ...actor, owns: true,
  comment: { id: "comment-1", authorId: "user-1", targetType: "ROADMAP_ITEM", targetId: "target-1", workspaceId: "workspace-1", parentId: null, replyCount: 0, hasPlanProposal: false },
}
const request = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(`http://compass.test${path}`, init)

beforeEach(() => {
  vi.clearAllMocks()
  authorizeTarget.mockResolvedValue(actor)
  authorizeExisting.mockResolvedValue(existing)
  listBrowserComments.mockResolvedValue([])
  createComment.mockResolvedValue({ id: "comment-1" })
  updateCommentBody.mockResolvedValue({ id: "comment-1", body: "Edited" })
  setCommentStatus.mockResolvedValue({ id: "comment-1", status: "RESOLVED" })
  deleteBrowserComment.mockResolvedValue({ id: "comment-1", deletedReplies: 0 })
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
    authorizeTarget.mockRejectedValue(new CommentHttpError(401, "Unauthorized"))
    expect((await GET(request("/api/comments?targetType=ROADMAP_ITEM&targetId=target-1"))).status).toBe(401)
  })

  it("lists through the server-resolved workspace", async () => {
    listBrowserComments.mockResolvedValue([{ id: "comment-1" }])
    toCommentThreads.mockReturnValue([{ id: "comment-1", replies: [] }])
    const response = await GET(request("/api/comments?targetType=ROADMAP_ITEM&targetId=target-1&workspaceId=evil"))
    expect(response.status).toBe(200)
    expect(listBrowserComments).toHaveBeenCalledWith("workspace-1", "ROADMAP_ITEM", "target-1")
    expect(await response.json()).toEqual({ items: [{ id: "comment-1", replies: [] }] })
  })
})

describe("POST /api/comments", () => {
  it("returns 400 for malformed JSON", async () => {
    const response = await POST(request("/api/comments", { method: "POST", body: "{" }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "Request body must be valid JSON" })
  })
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

  it("passes a validated element anchor through for a root ARTIFACT comment", async () => {
    const response = await POST(request("/api/comments", {
      method: "POST",
      body: JSON.stringify({
        targetType: "ARTIFACT", targetId: "target-1", body: "Looks off",
        elementAnchor: { pageUrl: "https://compass.test/acme/product/docs/artifacts/art-1", pagePath: "/acme/product/docs/artifacts/art-1", elementSelector: "button.cta", elementFingerprint: { tag: "button", rectXRatio: 0.2 }, screenshotUrl: "https://evil.example.com/tracker.png" },
      }),
    }))
    expect(response.status).toBe(201)
    expect(createComment).toHaveBeenCalledWith(expect.objectContaining({
      elementAnchor: {
        pageUrl: "https://compass.test/acme/product/docs/artifacts/art-1",
        pagePath: "/acme/product/docs/artifacts/art-1",
        elementSelector: "button.cta",
        elementFingerprint: { tag: "button", text: undefined, rectXRatio: 0.2, rectYRatio: undefined, rectWRatio: undefined, rectHRatio: undefined },
      },
    }))
    // screenshotUrl is never forwarded from client input — rebuilt field by field.
    const [callArgs] = createComment.mock.calls[0]
    expect(callArgs.elementAnchor).not.toHaveProperty("screenshotUrl")
  })

  it("omits elementAnchor entirely when the client sends none", async () => {
    await POST(request("/api/comments", { method: "POST", body: JSON.stringify({ targetType: "ROADMAP_ITEM", targetId: "target-1", body: "Hello" }) }))
    const [callArgs] = createComment.mock.calls[0]
    expect(callArgs).not.toHaveProperty("elementAnchor")
  })

  it("rejects an element anchor on a non-ARTIFACT target", async () => {
    const response = await POST(request("/api/comments", {
      method: "POST",
      body: JSON.stringify({ targetType: "ROADMAP_ITEM", targetId: "target-1", body: "Hello", elementAnchor: { pageUrl: "https://x", pagePath: "/x" } }),
    }))
    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain("ARTIFACT")
    expect(createComment).not.toHaveBeenCalled()
  })

  it("rejects an element anchor on a reply", async () => {
    const response = await POST(request("/api/comments", {
      method: "POST",
      body: JSON.stringify({ targetType: "ARTIFACT", targetId: "target-1", parentId: "parent-1", body: "Hello", elementAnchor: { pageUrl: "https://x", pagePath: "/x" } }),
    }))
    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain("root comment")
    expect(createComment).not.toHaveBeenCalled()
  })

  it("rejects an element anchor missing required fields", async () => {
    const response = await POST(request("/api/comments", {
      method: "POST",
      body: JSON.stringify({ targetType: "ARTIFACT", targetId: "target-1", body: "Hello", elementAnchor: { pageUrl: "" } }),
    }))
    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain("elementAnchor.pageUrl")
  })
})

describe("PATCH /api/comments/[id]", () => {
  it("returns 400 for malformed JSON", async () => {
    const response = await PATCH(request("/api/comments/comment-1", { method: "PATCH", body: "{" }), { params: Promise.resolve({ id: "comment-1" }) })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "Request body must be valid JSON" })
  })
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

  it("rejects status changes on replies", async () => {
    authorizeExisting.mockResolvedValue({ ...existing, comment: { ...existing.comment, parentId: "root-1" } })
    const response = await PATCH(request("/api/comments/comment-1", { method: "PATCH", body: JSON.stringify({ action: "resolve" }) }), { params: Promise.resolve({ id: "comment-1" }) })
    expect(response.status).toBe(400)
    expect(setCommentStatus).not.toHaveBeenCalled()
  })

  it("hides specialized Solution plan rows from generic mutation", async () => {
    authorizeExisting.mockResolvedValue({ ...existing, comment: { ...existing.comment, hasPlanProposal: true } })
    const response = await PATCH(request("/api/comments/comment-1", { method: "PATCH", body: JSON.stringify({ action: "edit", body: "Changed" }) }), { params: Promise.resolve({ id: "comment-1" }) })
    expect(response.status).toBe(404)
    expect(updateCommentBody).not.toHaveBeenCalled()
  })

  it("returns a generic 500 for unexpected failures", async () => {
    authorizeExisting.mockRejectedValue(new Error("database password leaked"))
    const response = await PATCH(request("/api/comments/comment-1", { method: "PATCH", body: JSON.stringify({ action: "edit", body: "Changed" }) }), { params: Promise.resolve({ id: "comment-1" }) })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: "Internal server error" })
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
    deleteBrowserComment.mockRejectedValueOnce(new (await import("@/lib/comment-browser")).CommentHttpError(409, "Admin confirmation is required to delete a thread with replies."))
    const response = await DELETE(request("/api/comments/comment-1", { method: "DELETE" }), { params: Promise.resolve({ id: "comment-1" }) })
    expect(response.status).toBe(409)
    expect(deleteBrowserComment).toHaveBeenCalledWith("comment-1", expect.anything(), false)
  })

  it("requires explicit confirmation before an admin deletes a thread", async () => {
    authorizeExisting.mockResolvedValue({ ...existing, admin: true, owns: false, comment: { ...existing.comment, replyCount: 2 } })
    deleteBrowserComment
      .mockRejectedValueOnce(new (await import("@/lib/comment-browser")).CommentHttpError(409, "Admin confirmation is required to delete a thread with replies."))
      .mockResolvedValueOnce({ id: "comment-1", deletedReplies: 2 })
    const unconfirmed = await DELETE(request("/api/comments/comment-1", { method: "DELETE" }), { params: Promise.resolve({ id: "comment-1" }) })
    const confirmed = await DELETE(request("/api/comments/comment-1?deleteThread=true", { method: "DELETE" }), { params: Promise.resolve({ id: "comment-1" }) })
    expect(unconfirmed.status).toBe(409)
    expect(confirmed.status).toBe(200)
    expect(deleteBrowserComment).toHaveBeenCalledTimes(2)
  })

  it("allows an author to delete a reply", async () => {
    authorizeExisting.mockResolvedValue({ ...existing, comment: { ...existing.comment, parentId: "root-1", replyCount: 0 } })
    const response = await DELETE(request("/api/comments/comment-1", { method: "DELETE" }), { params: Promise.resolve({ id: "comment-1" }) })
    expect(response.status).toBe(200)
    expect(deleteBrowserComment).toHaveBeenCalledWith("comment-1", expect.anything(), false)
  })
})
