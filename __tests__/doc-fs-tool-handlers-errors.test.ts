/**
 * resolvePath throws invalid-path for an empty, dot or whitespace segment. Every
 * path-addressed MCP handler must turn that into a clean tool failure, not let the
 * exception escape (deleteDoc, listDocHistory, restoreDocVersion and the comment tools
 * all resolve a path before doing anything else).
 */
import { describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ resolvePath: vi.fn() }))

vi.mock("@/lib/db", () => ({ default: () => ({}) }))
vi.mock("@/lib/doc-fs", () => {
  class DocFsError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message)
      this.name = "DocFsError"
    }
  }
  return { DocFsError, resolvePath: state.resolvePath, deletePath: vi.fn(), writePath: vi.fn(), movePath: vi.fn() }
})
vi.mock("@/lib/doc-comment-tool-handlers", () => ({
  addDocComment: vi.fn(),
  listDocComments: vi.fn(),
  resolveDocComment: vi.fn(),
  reopenDocComment: vi.fn(),
}))
vi.mock("@/lib/doc-versions", () => ({ restoreDocVersionCore: vi.fn() }))

import { addDocComment, deleteDoc, listDocComments, listDocHistory, resolveDocComment, restoreDocVersion } from "@/lib/doc-fs-tool-handlers"
import * as docFs from "@/lib/doc-fs"

const WS = "11111111-1111-4111-8111-111111111111"

describe("path-addressed handlers report an invalid path as a clean tool error", () => {
  const invalid = () => {
    state.resolvePath.mockRejectedValue(new docFs.DocFsError("invalid-path", 'Invalid doc path: "..".'))
  }
  const expectClean = (result: { structuredContent?: unknown }) => {
    expect(result.structuredContent).toMatchObject({ ok: false, message: expect.stringContaining("Invalid doc path") })
  }

  it("delete_doc", async () => {
    invalid()
    expectClean(await deleteDoc({ workspaceId: WS, path: ".." }))
  })

  it("list_doc_history", async () => {
    invalid()
    expectClean(await listDocHistory({ workspaceId: WS, path: ".." }))
  })

  it("restore_doc_version", async () => {
    invalid()
    expectClean(await restoreDocVersion({ workspaceId: WS, path: "..", versionId: "22222222-2222-4222-8222-222222222222" }))
  })

  it("add_doc_comment, list_doc_comments and resolve_doc_comment", async () => {
    invalid()
    expectClean(await addDocComment({ workspaceId: WS, path: "..", body: "x", authorName: "a" } as never))
    expectClean(await listDocComments({ workspaceId: WS, path: ".." } as never))
    expectClean(await resolveDocComment({ workspaceId: WS, path: "..", commentId: "c" } as never))
  })

  it("still says 'not found' for a valid path with no doc", async () => {
    state.resolvePath.mockResolvedValue(null)
    const result = await deleteDoc({ workspaceId: WS, path: "Nope" })
    expect(result.structuredContent).toMatchObject({ ok: false, message: expect.stringContaining("No doc found") })
  })

  it("rethrows an error that is not a doc-level failure", async () => {
    state.resolvePath.mockRejectedValue(new Error("database down"))
    await expect(deleteDoc({ workspaceId: WS, path: "Nope" })).rejects.toThrow("database down")
  })
})
