import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppPrismaClient } from "@/lib/db"

const mocks = vi.hoisted(() => ({ sync: vi.fn(), update: vi.fn() }))

vi.mock("@/lib/workspace-updates-capture", () => ({
  withWorkspaceUpdates: (db: unknown, _workspaceId: unknown, callback: (db: unknown, enabled: boolean) => unknown) => callback(db, false),
  withUpdatesTables: (db: unknown, callback: (db: unknown, tablesExist: boolean) => unknown) => callback(db, false),
  recordWorkspaceUpdate: vi.fn(),
}))
vi.mock("@/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/db", () => ({ default: () => ({}) }))
vi.mock("@/lib/comment-task-sync", () => ({ syncCommentThreadsForTaskStatus: mocks.sync }))

import { captureWorkspaceMutation } from "@/lib/workspace-update-mutations"
import { withFollowingCommit } from "@/lib/following-commit"

const WS = "00000000-0000-4000-8000-000000000001"
const findUnique = vi.fn()
const db = { task: { findUnique, update: mocks.update }, opportunity: { findUnique } } as unknown as AppPrismaClient

beforeEach(() => {
  vi.resetAllMocks()
  mocks.sync.mockResolvedValue({ resolved: [], reopened: [] })
})

describe("captureWorkspaceMutation -> Doc comment thread sync", () => {
  it("syncs threads when a task's status changes", async () => {
    findUnique.mockResolvedValue({ status: "IN_PROGRESS" })
    await captureWorkspaceMutation(db, "task", "update", "UI", "t1", async () => ({ id: "t1", workspaceId: WS, status: "DONE" }))
    expect(mocks.sync).toHaveBeenCalledTimes(1)
  })

  it("syncs on reopen too", async () => {
    findUnique.mockResolvedValue({ status: "DONE" })
    await captureWorkspaceMutation(db, "task", "update", "UI", "t1", async () => ({ id: "t1", workspaceId: WS, status: "TODO" }))
    expect(mocks.sync).toHaveBeenCalledTimes(1)
  })

  it("orders overlapping updates to one task so the second sees the first's status as its 'before'", async () => {
    // Without ordering both read TODO and the DONE -> TODO write looks like TODO -> TODO, so no sync runs for it.
    let stored = "TODO"
    findUnique.mockImplementation(async () => ({ status: stored }))
    const write = (status: string, delay: number) => captureWorkspaceMutation(db, "task", "update", "UI", "t1", async () => {
      await new Promise(resolve => setTimeout(resolve, delay))
      stored = status
      return { id: "t1", workspaceId: WS, status }
    })
    await Promise.all([write("DONE", 20), write("TODO", 0)])
    expect(mocks.sync.mock.calls).toEqual([["t1", "TODO", "DONE"], ["t1", "DONE", "TODO"]])
  })

  it("does not sync an edit that leaves the status alone", async () => {
    findUnique.mockResolvedValue({ status: "TODO" })
    await captureWorkspaceMutation(db, "task", "update", "UI", "t1", async () => ({ id: "t1", workspaceId: WS, status: "TODO", title: "Renamed" }))
    expect(mocks.sync).not.toHaveBeenCalled()
  })

  it("does not sync task creation or other models", async () => {
    await captureWorkspaceMutation(db, "task", "create", "UI", undefined, async () => ({ id: "t1", workspaceId: WS, status: "DONE" }))
    findUnique.mockResolvedValue({ status: "IDEA" })
    await captureWorkspaceMutation(db, "opportunity", "update", "UI", "o1", async () => ({ id: "o1", workspaceId: WS, status: "DONE" }))
    expect(mocks.sync).not.toHaveBeenCalled()
  })

  it("waits for the surrounding transaction to commit before syncing", async () => {
    findUnique.mockResolvedValue({ status: "TODO" })
    let syncedBeforeCommit = true
    await withFollowingCommit(async () => {
      await captureWorkspaceMutation(db, "task", "update", "UI", "t1", async () => ({ id: "t1", workspaceId: WS, status: "DONE" }))
      syncedBeforeCommit = mocks.sync.mock.calls.length > 0
    })
    expect(syncedBeforeCommit).toBe(false)
    expect(mocks.sync).toHaveBeenCalledTimes(1)
  })
})
