import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppPrismaClient } from "@/lib/db"

const mocks = vi.hoisted(() => ({ sync: vi.fn(), update: vi.fn() }))

vi.mock("@/lib/workspace-updates-capture", () => ({
  withWorkspaceUpdates: (db: unknown, callback: (db: unknown, enabled: boolean) => unknown) => callback(db, false),
  recordWorkspaceUpdate: vi.fn(),
}))
vi.mock("@/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/db", () => ({ default: () => ({}) }))
vi.mock("@/lib/comment-task-sync", () => ({ reconcileCommentThreadsForTask: mocks.sync }))

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
    expect(mocks.sync).toHaveBeenCalledWith("t1")
  })

  it("syncs on reopen too", async () => {
    findUnique.mockResolvedValue({ status: "DONE" })
    await captureWorkspaceMutation(db, "task", "update", "UI", "t1", async () => ({ id: "t1", workspaceId: WS, status: "TODO" }))
    expect(mocks.sync).toHaveBeenCalledWith("t1")
  })

  it("re-checks when a status write read no change: a stale 'before' under a concurrent flip", async () => {
    // Two writers both read TODO; the DONE -> TODO one therefore sees TODO -> TODO and would otherwise never sync.
    findUnique.mockResolvedValue({ status: "TODO" })
    mocks.update.mockResolvedValue({ id: "t1", workspaceId: WS, status: "TODO" })
    await captureWorkspaceMutation(db, "task", "update", "UI", "t1", async tx => tx.task.update({ where: { id: "t1" }, data: { status: "TODO" } }))
    expect(mocks.sync).toHaveBeenCalledWith("t1")
  })

  it("does not re-check a plain edit (title) that leaves the status alone", async () => {
    findUnique.mockResolvedValue({ status: "TODO" })
    mocks.update.mockResolvedValue({ id: "t1", workspaceId: WS, status: "TODO", title: "Renamed" })
    await captureWorkspaceMutation(db, "task", "update", "UI", "t1", async tx => tx.task.update({ where: { id: "t1" }, data: { title: "Renamed" } }))
    expect(mocks.sync).not.toHaveBeenCalled()
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
