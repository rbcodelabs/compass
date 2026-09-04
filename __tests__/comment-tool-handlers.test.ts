import { beforeEach, describe, expect, it, vi } from "vitest"

const core = vi.hoisted(() => ({ createComment: vi.fn(), listComments: vi.fn(), getComment: vi.fn(), updateCommentBody: vi.fn(), deleteComment: vi.fn(), setCommentStatus: vi.fn() }))
vi.mock("@/lib/comments", () => core)

import { addComment, deleteCommentTool, getCommentTool, listCommentsTool, reopenComment, resolveComment, updateComment } from "@/lib/comment-tool-handlers"

const comment = { id: "33333333-3333-3333-3333-333333333333", workspaceId: "11111111-1111-1111-1111-111111111111", targetType: "OPPORTUNITY", targetId: "22222222-2222-2222-2222-222222222222", parentId: null, body: "Useful context", status: "OPEN", authorName: "Claude", authorId: null, authorType: "AGENT", source: "MCP", createdAt: new Date("2026-09-04T12:00:00Z"), updatedAt: new Date("2026-09-04T12:00:00Z") }

beforeEach(() => vi.clearAllMocks())

describe("generic comment MCP handlers", () => {
  it("creates an agent-authored MCP comment with structured output", async () => {
    core.createComment.mockResolvedValue(comment)
    const result = await addComment({ workspaceId: comment.workspaceId, targetType: "OPPORTUNITY", targetId: comment.targetId, body: comment.body, authorName: "Claude" })
    expect(core.createComment).toHaveBeenCalledWith(expect.objectContaining({ authorType: "AGENT", source: "MCP" }))
    expect(result.structuredContent).toMatchObject({ ok: true, data: { id: comment.id } })
    expect(result.content[0].text).toContain(`ID: ${comment.id}`)
  })

  it("lists comments with count", async () => {
    core.listComments.mockResolvedValue([comment])
    const result = await listCommentsTool({ workspaceId: comment.workspaceId, targetType: "OPPORTUNITY", targetId: comment.targetId })
    expect(result.structuredContent.data).toMatchObject({ count: 1 })
  })

  it("returns structured failures for missing comments", async () => {
    core.getComment.mockResolvedValue(null)
    expect((await getCommentTool({ commentId: comment.id })).structuredContent.ok).toBe(false)
    core.updateCommentBody.mockResolvedValue(null)
    expect((await updateComment({ commentId: comment.id, body: "new" })).structuredContent.ok).toBe(false)
    core.deleteComment.mockResolvedValue(null)
    expect((await deleteCommentTool({ commentId: comment.id })).structuredContent.ok).toBe(false)
  })

  it("resolves and reopens via the shared status service", async () => {
    core.setCommentStatus.mockResolvedValueOnce({ ...comment, status: "RESOLVED" }).mockResolvedValueOnce(comment)
    expect((await resolveComment({ commentId: comment.id })).structuredContent.data).toMatchObject({ status: "RESOLVED" })
    expect((await reopenComment({ commentId: comment.id })).structuredContent.data).toMatchObject({ status: "OPEN" })
  })
})
