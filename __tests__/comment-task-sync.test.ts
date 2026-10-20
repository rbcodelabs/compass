import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  db: {
    taskLink: { findMany: vi.fn() },
    docComment: { findMany: vi.fn(), findUnique: vi.fn() },
    task: { count: vi.fn(), findUnique: vi.fn() },
  },
  setStatus: vi.fn(),
}))

vi.mock("@/lib/db", () => ({ default: () => mocks.db }))
vi.mock("@/lib/doc-comments", () => ({ setDocCommentStatusCore: mocks.setStatus }))

import { syncCommentThreadsForTaskStatus, threadStatusForTaskStatus, transitionTouchesThreads } from "@/lib/comment-task-sync"

const TASK = "task-1"
const ROOT = "comment-root"
const REPLY = "comment-reply"

/** A thread whose status is mutable, and a task whose current status is `taskStatus`. */
function world(threadStatus: "OPEN" | "RESOLVED", taskStatus: string, linked: Array<{ id: string; parentId: string | null }> = [{ id: ROOT, parentId: null }]) {
  const state = { thread: threadStatus, task: taskStatus }
  mocks.db.taskLink.findMany.mockResolvedValue(linked.map(c => ({ linkedId: c.id })))
  mocks.db.docComment.findMany.mockImplementation(async ({ where }: { where: { id?: unknown; parentId?: string } }) =>
    where.id ? linked : where.parentId ? [{ id: REPLY }] : [])
  mocks.db.docComment.findUnique.mockImplementation(async () => ({ id: ROOT, status: state.thread }))
  mocks.db.task.findUnique.mockImplementation(async () => ({ status: state.task }))
  mocks.setStatus.mockImplementation(async (id: string, next: "OPEN" | "RESOLVED") => { state.thread = next; return { id, status: next } })
  return state
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.db.task.count.mockResolvedValue(0)
})

describe("transitionTouchesThreads / threadStatusForTaskStatus", () => {
  it.each([
    ["TODO", "DONE", true], ["IN_PROGRESS", "DONE", true], ["DONE", "TODO", true], ["DONE", "CANCELLED", true],
    ["TODO", "IN_PROGRESS", false], ["IN_PROGRESS", "BLOCKED", false], ["DONE", "DONE", false], ["TODO", "CANCELLED", false],
  ])("%s -> %s touches threads: %s", (from, to, expected) => {
    expect(transitionTouchesThreads(from, to)).toBe(expected)
  })

  it.each([["DONE", "RESOLVED"], ["TODO", "OPEN"], ["IN_PROGRESS", "OPEN"], ["IN_REVIEW", "OPEN"], ["CANCELLED", null]])(
    "a %s task asks for %s",
    (status, expected) => expect(threadStatusForTaskStatus(status)).toBe(expected),
  )
})

describe("syncCommentThreadsForTaskStatus", () => {
  it("resolves the open thread when the task becomes DONE", async () => {
    const w = world("OPEN", "DONE")
    const result = await syncCommentThreadsForTaskStatus(TASK, "IN_PROGRESS", "DONE")
    expect(w.thread).toBe("RESOLVED")
    expect(result).toEqual({ resolved: [ROOT], reopened: [] })
  })

  it("reopens a resolved thread when a DONE task is reopened", async () => {
    const w = world("RESOLVED", "IN_PROGRESS")
    const result = await syncCommentThreadsForTaskStatus(TASK, "DONE", "IN_PROGRESS")
    expect(w.thread).toBe("OPEN")
    expect(result).toEqual({ resolved: [], reopened: [ROOT] })
  })

  it("is idempotent: a thread already in the wanted state is not written again", async () => {
    world("RESOLVED", "DONE")
    await syncCommentThreadsForTaskStatus(TASK, "IN_PROGRESS", "DONE")
    await syncCommentThreadsForTaskStatus(TASK, "IN_PROGRESS", "DONE")
    expect(mocks.setStatus).not.toHaveBeenCalled()
  })

  it("trusts the task's CURRENT status, not the triggering write: a stale DONE trigger after a reopen leaves the thread open", async () => {
    // The write that said TODO -> DONE finished its sync late, after the task was already flipped back to TODO.
    const w = world("OPEN", "TODO")
    await syncCommentThreadsForTaskStatus(TASK, "TODO", "DONE")
    expect(w.thread).toBe("OPEN")
    expect(mocks.setStatus).not.toHaveBeenCalled()
  })

  it("trusts the current status the other way too: a stale reopen trigger while the task is DONE keeps the thread resolved", async () => {
    const w = world("RESOLVED", "DONE")
    await syncCommentThreadsForTaskStatus(TASK, "DONE", "TODO")
    expect(w.thread).toBe("RESOLVED")
  })

  it("runs overlapping syncs for one task one at a time, so the last status wins", async () => {
    // Two flips fire back to back; the first sync is slow. Interleaving them lets the stale one overwrite the newer result.
    const w = world("OPEN", "DONE")
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const original = mocks.setStatus.getMockImplementation()!
    mocks.setStatus.mockImplementationOnce(async (id: string, next: "OPEN" | "RESOLVED") => { await gate; return original(id, next) })

    const first = syncCommentThreadsForTaskStatus(TASK, "TODO", "DONE")
    await new Promise(resolve => setTimeout(resolve, 0))
    w.task = "TODO" // the task is reopened while the first sync is still writing
    const second = syncCommentThreadsForTaskStatus(TASK, "DONE", "TODO")
    release()
    await Promise.all([first, second])
    expect(w.thread).toBe("OPEN")
  })

  it("re-checks after writing: a status flip during the write is followed", async () => {
    const w = world("OPEN", "DONE")
    const original = mocks.setStatus.getMockImplementation()!
    mocks.setStatus.mockImplementationOnce(async (id: string, next: "OPEN" | "RESOLVED") => {
      const row = await original(id, next)
      w.task = "TODO" // flipped by another instance mid-sync
      return row
    })
    await syncCommentThreadsForTaskStatus(TASK, "TODO", "DONE")
    expect(w.thread).toBe("OPEN")
  })

  it("never touches a Task, so a manual thread change cannot loop back", async () => {
    world("OPEN", "DONE")
    await syncCommentThreadsForTaskStatus(TASK, "TODO", "DONE")
    expect(mocks.db.task).not.toHaveProperty("update")
  })

  it("syncs the root thread when the task was made from a reply", async () => {
    const w = world("OPEN", "DONE", [{ id: REPLY, parentId: ROOT }])
    await syncCommentThreadsForTaskStatus(TASK, "TODO", "DONE")
    expect(w.thread).toBe("RESOLVED")
  })

  it("keeps the thread open while another task in it is still live", async () => {
    const w = world("OPEN", "DONE")
    mocks.db.task.count.mockResolvedValue(1)
    await syncCommentThreadsForTaskStatus(TASK, "TODO", "DONE")
    expect(w.thread).toBe("OPEN")
    expect(mocks.db.task.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: { not: TASK }, status: { notIn: ["DONE", "CANCELLED"] } }),
    })
  })

  it("leaves the thread alone when the task ends up CANCELLED", async () => {
    const w = world("RESOLVED", "CANCELLED")
    await syncCommentThreadsForTaskStatus(TASK, "DONE", "CANCELLED")
    expect(w.thread).toBe("RESOLVED")
  })

  it("does nothing for a task with no comment links", async () => {
    mocks.db.taskLink.findMany.mockResolvedValue([])
    expect(await syncCommentThreadsForTaskStatus(TASK, "TODO", "DONE")).toEqual({ resolved: [], reopened: [] })
    expect(mocks.setStatus).not.toHaveBeenCalled()
  })

  it("skips the database entirely when the transition does not cross DONE", async () => {
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
