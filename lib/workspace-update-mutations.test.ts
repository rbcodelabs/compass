import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppPrismaClient } from "./db"
const mocks = vi.hoisted(() => ({ enabled: true, record: vi.fn(), auth: vi.fn() }))
vi.mock("./workspace-updates-capture", () => ({ withWorkspaceUpdates: (db: unknown, callback: (db: unknown, enabled: boolean) => unknown) => callback(db, mocks.enabled), recordWorkspaceUpdate: mocks.record }))
vi.mock("@/auth", () => ({ auth: mocks.auth }))
import { captureWorkspaceMutation } from "./workspace-update-mutations"
import { runWithMcpActor } from "./mcp-authz"
const actor = { actorType: "USER" as const, actorId: "user" }
const findUnique = vi.fn()
const db = { task: { findUnique }, opportunity: { findUnique }, solution: { findUnique }, assumption: { findUnique }, roadmapItem: { findUnique }, experiment: { findUnique } } as unknown as AppPrismaClient
beforeEach(() => { vi.resetAllMocks(); mocks.enabled = true })
describe("explicit capture adapters", () => {
  it("uses the transaction client and emits nothing for title, ordering, or repeated status edits", async () => {
    findUnique.mockResolvedValue({ id: "t", workspaceId: "w", status: "TODO" })
    const mutate = vi.fn().mockResolvedValue({ id: "t", workspaceId: "w", status: "TODO", sortOrder: 9, title: "Renamed" })
    await captureWorkspaceMutation(db, "task", "update", actor, "t", mutate)
    expect(mutate).toHaveBeenCalledWith(db)
    expect(mocks.record).not.toHaveBeenCalled()
  })
  it("resolves assumption workspace through its explicit ancestors", async () => {
    findUnique.mockResolvedValueOnce({ id: "s", opportunityId: "o" }).mockResolvedValueOnce({ id: "o", workspaceId: "w" })
    await captureWorkspaceMutation(db, "assumption", "create", actor, undefined, async () => ({ id: "a", solutionId: "s" }))
    expect(mocks.record).toHaveBeenCalledWith(db, expect.objectContaining({ workspaceId: "w", entityType: "ASSUMPTION", kind: "CREATED" }))
  })
  it("groups experiment results under the experiment without copying result text", async () => {
    findUnique.mockResolvedValue({ id: "e", workspaceId: "w" })
    await captureWorkspaceMutation(db, "experimentResult", "create", actor, undefined, async () => ({ id: "result", experimentId: "e", note: "private content" }))
    expect(mocks.record).toHaveBeenCalledWith(db, expect.objectContaining({ entityType: "EXPERIMENT", entityId: "e", groupId: "e", kind: "RESULT_ADDED" }))
    expect(JSON.stringify(mocks.record.mock.calls)).not.toContain("private content")
  })
  it("records horizon changes independently of unchanged active status", async () => {
    findUnique.mockResolvedValue({ id: "r", workspaceId: "w", status: "ACTIVE", horizon: "LATER" })
    await captureWorkspaceMutation(db, "roadmapItem", "update", actor, "r", async () => ({ id: "r", workspaceId: "w", status: "ACTIVE", horizon: "NEXT" }))
    expect(mocks.record).toHaveBeenCalledTimes(1)
    expect(mocks.record).toHaveBeenCalledWith(db, expect.objectContaining({ before: "LATER", after: "NEXT" }))
  })
  it("preserves service identity instead of inventing a human actor", async () => {
    await runWithMcpActor({ purpose: "SERVICE", userId: "credential-owner" }, () => captureWorkspaceMutation(db, "task", "create", "MCP", undefined, async () => ({ id: "t", workspaceId: "w" })))
    expect(mocks.record).toHaveBeenCalledWith(db, expect.objectContaining({ actorType: "SYSTEM", actorId: null }))
  })
  it("leaves disabled writes untouched without requiring a new auth context", async () => {
    mocks.enabled = false
    await captureWorkspaceMutation(db, "task", "create", "UI", undefined, async () => ({ id: "t" }))
    expect(mocks.auth).not.toHaveBeenCalled()
    expect(mocks.record).not.toHaveBeenCalled()
  })
  it("propagates capture failure to the transaction owner", async () => {
    mocks.record.mockRejectedValue(new Error("event unavailable"))
    await expect(captureWorkspaceMutation(db, "task", "create", actor, undefined, async () => ({ id: "t", workspaceId: "w" }))).rejects.toThrow("event unavailable")
  })
  it("does not record a rejected business mutation", async () => {
    await expect(captureWorkspaceMutation(db, "task", "create", actor, undefined, async () => { throw new Error("denied") })).rejects.toThrow("denied")
    expect(mocks.record).not.toHaveBeenCalled()
  })
})
