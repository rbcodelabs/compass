import { beforeEach, expect, it, vi } from "vitest"
const { findMany, commentList, commentGet, docList, docGet } = vi.hoisted(() => ({ findMany: vi.fn(), commentList: vi.fn(), commentGet: vi.fn(), docList: vi.fn(), docGet: vi.fn() }))
vi.mock("@/lib/db", () => ({ default: () => ({ user: { findMany }, comment: { findMany: commentList, findUnique: commentGet }, docComment: { findMany: docList, findUnique: docGet } }) }))
import { resolveCommentAuthors } from "@/lib/comment-authors"
import { listComments, getComment } from "@/lib/comments"
import { listDocCommentsCore, getDocCommentCore } from "@/lib/doc-comments"
const row = { authorId: "person", authorType: "HUMAN", authorName: "Old name", createdAt: new Date(0), updatedAt: new Date(0) }
beforeEach(() => { vi.clearAllMocks(); findMany.mockResolvedValue([{ id: "person", name: "Current name", email: "person@example.com" }]) })
it("falls back to email for an empty name and retains missing users' snapshots", async () => {
  findMany.mockResolvedValue([{ id: "person", name: "  ", email: "person@example.com" }])
  expect(await resolveCommentAuthors([row, { ...row, authorId: "deleted" }])).toEqual([{ ...row, authorName: "person@example.com" }, { ...row, authorId: "deleted" }])
  expect(row.authorName).toBe("Old name")
})
it("never resolves agents or identity-less legacy snapshots", async () => {
  const rows = [{ ...row, authorType: "AGENT" }, { ...row, authorId: null }]
  expect(await resolveCommentAuthors(rows)).toEqual(rows)
  expect(findMany).not.toHaveBeenCalled()
})
it("deduplicates human IDs in one query without querying agent IDs", async () => {
  await resolveCommentAuthors([row, row, { ...row, authorId: "agent-id", authorType: "AGENT" }, { ...row, authorId: "second-person" }])
  expect(findMany).toHaveBeenCalledTimes(1)
  expect(findMany).toHaveBeenCalledWith({ where: { id: { in: ["person", "second-person"] } }, select: { id: true, name: true, email: true } })
})
it("preserves missing comment results without a profile lookup", async () => {
  commentGet.mockResolvedValue(null)
  docGet.mockResolvedValue(null)
  expect(await getComment("missing")).toBeNull()
  expect(await getDocCommentCore("missing")).toBeNull()
  expect(findMany).not.toHaveBeenCalled()
})
it.each([
  ["shared list", () => listComments("workspace", "TASK", "target"), commentList, true],
  ["shared get", () => getComment("comment"), commentGet, false],
  ["Doc list", () => listDocCommentsCore("doc"), docList, true],
  ["Doc get", () => getDocCommentCore("comment"), docGet, false],
] as const)("resolves current names through %s without altering timestamps", async (_label, read, mock, list) => {
  mock.mockResolvedValue(list ? [row] : row)
  const expected = { ...row, authorName: "Current name" }
  expect(await read()).toEqual(list ? [expected] : expected)
})
