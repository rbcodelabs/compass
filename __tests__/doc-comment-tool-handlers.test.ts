/**
 * Unit tests for the DocComment MCP tool handlers (add_doc_comment,
 * list_doc_comments, get_doc_comment, update_doc_comment, delete_doc_comment,
 * resolve_doc_comment, reopen_doc_comment).
 *
 * The thread/anchor/cascade rules themselves live in lib/doc-comments.ts and
 * have their behaviour asserted through these handlers; here we mock that core
 * module and only assert the handlers forward the right arguments and shape the
 * response text (including the plain `ID: <uuid>` line agents parse).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

// --- Prisma mock (only list_doc_comments touches prisma directly) ------------
const mockDoc = { findUnique: vi.fn() }
const mockPrisma = { doc: mockDoc }
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

// --- Core logic mock ---------------------------------------------------------
const mockCreate = vi.fn()
const mockList = vi.fn()
const mockGet = vi.fn()
const mockUpdateBody = vi.fn()
const mockSetStatus = vi.fn()
const mockDelete = vi.fn()
vi.mock("@/lib/doc-comments", () => ({
  createDocCommentCore: (...a: unknown[]) => mockCreate(...a),
  listDocCommentsCore: (...a: unknown[]) => mockList(...a),
  getDocCommentCore: (...a: unknown[]) => mockGet(...a),
  updateDocCommentBodyCore: (...a: unknown[]) => mockUpdateBody(...a),
  setDocCommentStatusCore: (...a: unknown[]) => mockSetStatus(...a),
  deleteDocCommentCore: (...a: unknown[]) => mockDelete(...a),
}))

import {
  addDocComment,
  listDocComments,
  getDocComment,
  updateDocComment,
  deleteDocComment,
  resolveDocComment,
  reopenDocComment,
} from "@/lib/doc-comment-tool-handlers"

const DOC_ID = "11111111-1111-1111-1111-111111111111"
const COMMENT_ID = "22222222-2222-2222-2222-222222222222"
const PARENT_ID = "33333333-3333-3333-3333-333333333333"
const NOW = new Date("2026-08-13T12:00:00.000Z")

function textOf(result: { content: { text: string }[] }) {
  return result.content[0].text
}

function makeComment(overrides: Record<string, unknown> = {}) {
  return {
    id: COMMENT_ID,
    docId: DOC_ID,
    parentId: null,
    body: "This needs a rework",
    status: "OPEN",
    anchorText: "brown fox",
    anchorPrefix: null,
    anchorSuffix: null,
    anchorStart: 10,
    anchorEnd: 19,
    authorName: "Claude",
    authorId: null,
    authorType: "AGENT",
    source: "MCP",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDoc.findUnique.mockResolvedValue({ id: DOC_ID, title: "Product Vision" })
})

// ── add_doc_comment ─────────────────────────────────────────────────────────

describe("addDocComment", () => {
  it("forwards anchor fields and fixed AGENT/MCP identity to the core", async () => {
    mockCreate.mockResolvedValueOnce({ ok: true, comment: makeComment() })

    await addDocComment({
      docId: DOC_ID,
      body: "This needs a rework",
      authorName: "Claude",
      anchorText: "brown fox",
      anchorStart: 10,
      anchorEnd: 19,
    })

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        docId: DOC_ID,
        body: "This needs a rework",
        authorName: "Claude",
        authorType: "AGENT",
        source: "MCP",
        anchorText: "brown fox",
        anchorStart: 10,
        anchorEnd: 19,
        parentId: null,
      })
    )
  })

  it("returns a plain ID line for a created anchored comment", async () => {
    mockCreate.mockResolvedValueOnce({ ok: true, comment: makeComment() })
    const text = textOf(await addDocComment({ docId: DOC_ID, body: "x", authorName: "Claude" }))
    expect(text).toContain(`ID: ${COMMENT_ID}`)
    expect(text).not.toContain("**ID:**")
    expect(text).toContain("Anchored comment added")
  })

  it("labels a general (unanchored) comment distinctly", async () => {
    mockCreate.mockResolvedValueOnce({ ok: true, comment: makeComment({ anchorText: null }) })
    const text = textOf(await addDocComment({ docId: DOC_ID, body: "x", authorName: "Claude" }))
    expect(text).toContain("Comment added")
  })

  it("labels a reply distinctly and forwards parentId", async () => {
    mockCreate.mockResolvedValueOnce({ ok: true, comment: makeComment({ parentId: PARENT_ID, anchorText: null }) })
    const text = textOf(
      await addDocComment({ docId: DOC_ID, body: "agreed", authorName: "Claude", parentId: PARENT_ID })
    )
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ parentId: PARENT_ID }))
    expect(text).toContain("Reply added")
  })

  it("maps DOC_NOT_FOUND to a not-found message", async () => {
    mockCreate.mockResolvedValueOnce({ ok: false, error: "DOC_NOT_FOUND" })
    expect(textOf(await addDocComment({ docId: DOC_ID, body: "x", authorName: "Claude" }))).toContain("not found")
  })

  it("explains the one-level-deep rule on PARENT_IS_REPLY", async () => {
    mockCreate.mockResolvedValueOnce({ ok: false, error: "PARENT_IS_REPLY" })
    const text = textOf(
      await addDocComment({ docId: DOC_ID, body: "x", authorName: "Claude", parentId: PARENT_ID })
    )
    expect(text).toContain("one level deep")
  })
})

// ── list_doc_comments ───────────────────────────────────────────────────────

describe("listDocComments", () => {
  it("returns a not-found message when the doc does not exist", async () => {
    mockDoc.findUnique.mockResolvedValueOnce(null)
    const result = await listDocComments({ docId: DOC_ID })
    expect(textOf(result)).toContain("not found")
    expect(mockList).not.toHaveBeenCalled()
  })

  it("passes a status filter through to the core", async () => {
    mockList.mockResolvedValueOnce([])
    await listDocComments({ docId: DOC_ID, status: "RESOLVED" })
    expect(mockList).toHaveBeenCalledWith(DOC_ID, "RESOLVED")
  })

  it("reports an empty result distinctly", async () => {
    mockList.mockResolvedValueOnce([])
    expect(textOf(await listDocComments({ docId: DOC_ID }))).toContain("No comments")
  })

  it("groups replies under their root thread with plain ID lines", async () => {
    mockList.mockResolvedValueOnce([
      makeComment({ id: "root-1", parentId: null, body: "root body", anchorText: "fox" }),
      makeComment({ id: "reply-1", parentId: "root-1", body: "reply body", anchorText: null }),
    ])
    const text = textOf(await listDocComments({ docId: DOC_ID }))
    expect(text).toContain("root body")
    expect(text).toContain("ID: root-1")
    expect(text).toContain("reply body")
    expect(text).toContain("ID: reply-1")
    expect(text).toContain("1 thread")
  })
})

// ── get_doc_comment ─────────────────────────────────────────────────────────

describe("getDocComment", () => {
  it("returns not-found when missing", async () => {
    mockGet.mockResolvedValueOnce(null)
    expect(textOf(await getDocComment({ commentId: COMMENT_ID }))).toContain("not found")
  })

  it("returns the full comment with a plain ID line", async () => {
    mockGet.mockResolvedValueOnce(makeComment())
    const text = textOf(await getDocComment({ commentId: COMMENT_ID }))
    expect(text).toContain("This needs a rework")
    expect(text).toContain("Anchored to:")
    expect(text).toContain(`ID: ${COMMENT_ID}`)
    expect(text).not.toContain("**ID:**")
  })
})

// ── update_doc_comment ──────────────────────────────────────────────────────

describe("updateDocComment", () => {
  it("returns not-found when missing", async () => {
    mockUpdateBody.mockResolvedValueOnce(null)
    expect(textOf(await updateDocComment({ commentId: COMMENT_ID, body: "new" }))).toContain("not found")
  })

  it("forwards the body and returns a plain ID line", async () => {
    mockUpdateBody.mockResolvedValueOnce(makeComment({ body: "revised body" }))
    const text = textOf(await updateDocComment({ commentId: COMMENT_ID, body: "revised body" }))
    expect(mockUpdateBody).toHaveBeenCalledWith(COMMENT_ID, "revised body")
    expect(text).toContain("revised body")
    expect(text).toContain(`ID: ${COMMENT_ID}`)
  })
})

// ── delete_doc_comment ──────────────────────────────────────────────────────

describe("deleteDocComment", () => {
  it("returns not-found when missing", async () => {
    mockDelete.mockResolvedValueOnce(null)
    expect(textOf(await deleteDocComment({ commentId: COMMENT_ID }))).toContain("not found")
  })

  it("notes cascaded replies when a root is deleted", async () => {
    mockDelete.mockResolvedValueOnce({ id: COMMENT_ID, wasRoot: true, deletedReplies: 2 })
    const text = textOf(await deleteDocComment({ commentId: COMMENT_ID }))
    expect(text).toContain("2 replies also removed")
    expect(text).toContain(`ID: ${COMMENT_ID}`)
  })

  it("does not mention replies when a reply is deleted", async () => {
    mockDelete.mockResolvedValueOnce({ id: COMMENT_ID, wasRoot: false, deletedReplies: 0 })
    const text = textOf(await deleteDocComment({ commentId: COMMENT_ID }))
    expect(text).not.toContain("also removed")
  })
})

// ── resolve_doc_comment / reopen_doc_comment ────────────────────────────────

describe("resolveDocComment / reopenDocComment", () => {
  it("resolve sets RESOLVED via the core", async () => {
    mockSetStatus.mockResolvedValueOnce(makeComment({ status: "RESOLVED" }))
    const text = textOf(await resolveDocComment({ commentId: COMMENT_ID }))
    expect(mockSetStatus).toHaveBeenCalledWith(COMMENT_ID, "RESOLVED")
    expect(text).toContain("resolved")
    expect(text).toContain("Status: RESOLVED")
  })

  it("reopen sets OPEN via the core", async () => {
    mockSetStatus.mockResolvedValueOnce(makeComment({ status: "OPEN" }))
    const text = textOf(await reopenDocComment({ commentId: COMMENT_ID }))
    expect(mockSetStatus).toHaveBeenCalledWith(COMMENT_ID, "OPEN")
    expect(text).toContain("reopened")
  })

  it("returns not-found when the comment is missing", async () => {
    mockSetStatus.mockResolvedValueOnce(null)
    expect(textOf(await resolveDocComment({ commentId: COMMENT_ID }))).toContain("not found")
  })
})
