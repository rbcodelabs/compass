import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  db: {
    taskLink: { findMany: vi.fn() },
    docComment: { findMany: vi.fn(), findUnique: vi.fn() },
    task: { count: vi.fn() },
  },
  setStatus: vi.fn(),
}))

vi.mock("@/lib/db", () => ({ default: () => mocks.db }))
vi.mock("@/lib/doc-comments", () => ({ setDocCommentStatusCore: mocks.setStatus }))

import { syncCommentThreadsForTaskStatus, threadStatusForTransition } from "@/lib/comment-task-sync"

const TASK = "task-1"
const ROOT = "comment-root"
const REPLY = "comment-reply"

function threadIs(status: "OPEN" | "RESOLVED", linked: Array<{ id: string; parentId: string | null }> = [{ id: ROOT, parentId: null }]) {
  mocks.db.taskLink.findMany.mockResolvedValue(linked.map(c => ({ linkedId: c.id })))
  mocks.db.docComment.findMany.mockImplementation(async ({ where }: { where: { id?: unknown; parentId?: string } }) =>
    where.id ? linked : where.parentId ? [{ id: REPLY }] : [])
  mocks.db.docComment.findUnique.mockResolvedValue({ id: ROOT, status })
  mocks.setStatus.mockImplementation(async (id: string, next: string) => ({ id, status: next }))
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.db.task.count.mockResolvedValue(0)
})

describe("threadStatusForTransition", () => {
  it.each([
    ["TODO", "DONE", "RESOLVED"],
    ["IN_PROGRESS", "DONE", "RESOLVED"],
    ["IN_REVIEW", "DONE", "RESOLVED"],
    ["DONE", "TODO", "OPEN"],
    ["DONE", "IN_PROGRESS", "OPEN"],
    ["DONE", "IN_REVIEW", "OPEN"],
  ])("%s -> %s asks for %s", (from, to, expected) => {
    expect(threadStatusForTransition(from, to)).toBe(expected)
  })

  it.each([
    ["TODO", "IN_PROGRESS"],
    ["IN_PROGRESS", "BLOCKED"],
    ["DONE", "DONE"],
    ["DONE", "CANCELLED"],
    ["TODO", "CANCELLED"],
  ])("%s -> %s leaves the thread alone", (from, to) => {
    expect(threadStatusForTransition(from, to)).toBeNull()
  })
})

describe("syncCommentThreadsForTaskStatus", () => {
  it("resolves the open thread when the task becomes DONE", async () => {
    threadIs("OPEN")
    const result = await syncCommentThreadsForTaskStatus(TASK, "IN_PROGRESS", "DONE")
    expect(mocks.setStatus).toHaveBeenCalledWith(ROOT, "RESOLVED")
    expect(result).toEqual({ resolved: [ROOT], reopened: [] })
  })

  it("reopens a resolved thread when a DONE task is reopened", async () => {
    threadIs("RESOLVED")
    const result = await syncCommentThreadsForTaskStatus(TASK, "DONE", "IN_PROGRESS")
    expect(mocks.setStatus).toHaveBeenCalledWith(ROOT, "OPEN")
    expect(result).toEqual({ resolved: [], reopened: [ROOT] })
  })

  it("is idempotent: a thread already in the wanted state is not written again", async () => {
    threadIs("RESOLVED")
    await syncCommentThreadsForTaskStatus(TASK, "IN_PROGRESS", "DONE")
    await syncCommentThreadsForTaskStatus(TASK, "IN_PROGRESS", "DONE")
    expect(mocks.setStatus).not.toHaveBeenCalled()
  })

  it("never touches a Task, so a manual thread change cannot loop back", async () => {
    threadIs("OPEN")
    await syncCommentThreadsForTaskStatus(TASK, "TODO", "DONE")
    expect(Object.keys(mocks.db)).toEqual(["taskLink", "docComment", "task"])
    // The only write is the comment status; the task delegate is read-only (count).
    expect(mocks.db.task).not.toHaveProperty("update")
  })

  it("syncs the root thread when the task was made from a reply", async () => {
    threadIs("OPEN", [{ id: REPLY, parentId: ROOT }])
    await syncCommentThreadsForTaskStatus(TASK, "TODO", "DONE")
    expect(mocks.setStatus).toHaveBeenCalledWith(ROOT, "RESOLVED")
  })

  it("keeps the thread open while another task in it is still live", async () => {
    threadIs("OPEN")
    mocks.db.task.count.mockResolvedValue(1)
    const result = await syncCommentThreadsForTaskStatus(TASK, "TODO", "DONE")
    expect(mocks.setStatus).not.toHaveBeenCalled()
    expect(result.resolved).toEqual([])
    // The check excludes the task itself and ignores finished tasks.
    expect(mocks.db.task.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: { not: TASK }, status: { notIn: ["DONE", "CANCELLED"] } }),
    })
  })

  it("does nothing for a task with no comment links", async () => {
    mocks.db.taskLink.findMany.mockResolvedValue([])
    const result = await syncCommentThreadsForTaskStatus(TASK, "TODO", "DONE")
    expect(mocks.setStatus).not.toHaveBeenCalled()
    expect(result).toEqual({ resolved: [], reopened: [] })
  })

  it("skips the database entirely when the transition asks for nothing", async () => {
    await syncCommentThreadsForTaskStatus(TASK, "TODO", "IN_PROGRESS")
    expect(mocks.db.taskLink.findMany).not.toHaveBeenCalled()
  })

  it("never throws: a sync failure is logged and the task edit stands", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.db.taskLink.findMany.mockRejectedValue(new Error("db down"))
    await expect(syncCommentThreadsForTaskStatus(TASK, "TODO", "DONE")).resolves.toEqual({ resolved: [], reopened: [] })
    expect(log).toHaveBeenCalled()
  })
})
