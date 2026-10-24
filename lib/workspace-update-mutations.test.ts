import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppPrismaClient } from "./db"
import { setFeatureTables, setModules } from "../__tests__/helpers/modules"
import { isModuleEnabled } from "./modules/server"
// The adapter opens its transaction whenever the update tables exist and decides per workspace afterwards, from the row it wrote.
const mocks = vi.hoisted(() => ({ tablesExist: true, record: vi.fn(), auth: vi.fn() }))
vi.mock("./workspace-updates-capture", () => ({ withUpdatesTables: (db: unknown, callback: (db: unknown, tablesExist: boolean) => unknown) => callback(db, mocks.tablesExist), recordWorkspaceUpdate: mocks.record }))
vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("@/lib/db", () => ({ default: () => ({}) }))
import { captureWorkspaceMutation } from "./workspace-update-mutations"
import { runWithMcpActor } from "./mcp-authz"
const actor = { actorType: "USER" as const, actorId: "user" }
const findUnique = vi.fn()
const db = { task: { findUnique }, opportunity: { findUnique }, solution: { findUnique }, assumption: { findUnique }, roadmapItem: { findUnique }, experiment: { findUnique } } as unknown as AppPrismaClient
beforeEach(() => {
  vi.resetAllMocks()
  mocks.tablesExist = true
  setFeatureTables({ updates: true })
  setModules({ workspace_updates: true })
})
describe("explicit capture adapters", () => {
  it("uses the transaction client and emits nothing for title, ordering, or repeated status edits", async () => {
    findUnique.mockResolvedValue({ id: "t", workspaceId: "w", status: "TODO" })
    const mutate = vi.fn().mockResolvedValue({ id: "t", workspaceId: "w", status: "TODO", sortOrder: 9, title: "Renamed" })
    await captureWorkspaceMutation(db, "task", "update", actor, "t", mutate)
    expect(mutate).toHaveBeenCalledWith(db)
    expect(mocks.record).not.toHaveBeenCalled()
  })
  it("resolves assumption workspace through its Solution's own workspaceId", async () => {
    findUnique.mockResolvedValueOnce({ id: "s", workspaceId: "w", opportunityId: "o" })
    await captureWorkspaceMutation(db, "assumption", "create", actor, undefined, async () => ({ id: "a", solutionId: "s" }))
    expect(mocks.record).toHaveBeenCalledWith(db, expect.objectContaining({ workspaceId: "w", entityType: "ASSUMPTION", kind: "CREATED" }))
    // One lookup: the Solution. The Opportunity is never consulted for scope.
    expect(findUnique).toHaveBeenCalledTimes(1)
  })
  it("never attributes a Solution with no workspaceId through its Opportunity (the write succeeds, uncaptured)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    findUnique.mockResolvedValueOnce({ id: "s", workspaceId: null, opportunityId: "o" }).mockResolvedValueOnce({ id: "o", workspaceId: "w" })
    await expect(captureWorkspaceMutation(db, "solution", "create", actor, undefined, async () => ({ id: "s", workspaceId: null, opportunityId: "o", status: "IDEA" })))
      .resolves.toMatchObject({ id: "s" })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    expect(mocks.record).not.toHaveBeenCalled()
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
  it("leaves writes untouched without requiring a new auth context when the workspace has the module off", async () => {
    setModules({ workspace_updates: false })
    await captureWorkspaceMutation(db, "task", "create", "UI", undefined, async () => ({ id: "t", workspaceId: "w" }))
    expect(mocks.auth).not.toHaveBeenCalled()
    expect(mocks.record).not.toHaveBeenCalled()
  })
  it("leaves writes untouched before the update tables exist, even for a row that names no workspace", async () => {
    mocks.tablesExist = false
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
describe("per-workspace module decision", () => {
  it("captures for the workspace with the module on and skips the one with it off, with the same adapter setup", async () => {
    vi.mocked(isModuleEnabled).mockImplementation(async (workspaceId, key) => key === "workspace_updates" && workspaceId === "on")
    try {
      await captureWorkspaceMutation(db, "task", "create", actor, undefined, async () => ({ id: "t-off", workspaceId: "off" }))
      expect(mocks.record).not.toHaveBeenCalled()
      await captureWorkspaceMutation(db, "task", "create", actor, undefined, async () => ({ id: "t-on", workspaceId: "on" }))
      expect(mocks.record).toHaveBeenCalledTimes(1)
      expect(mocks.record).toHaveBeenCalledWith(db, expect.objectContaining({ workspaceId: "on", entityId: "t-on", kind: "CREATED" }))
    } finally {
      vi.mocked(isModuleEnabled).mockReset()
    }
  })
  it("decides per row for an update too: the status transition is recorded only in the workspace that has the module", async () => {
    vi.mocked(isModuleEnabled).mockImplementation(async (workspaceId, key) => key === "workspace_updates" && workspaceId === "on")
    try {
      findUnique.mockResolvedValue({ id: "t", status: "TODO" })
      await captureWorkspaceMutation(db, "task", "update", actor, "t", async () => ({ id: "t", workspaceId: "off", status: "DONE" }))
      expect(mocks.record).not.toHaveBeenCalled()
      await captureWorkspaceMutation(db, "task", "update", actor, "t", async () => ({ id: "t", workspaceId: "on", status: "DONE" }))
      expect(mocks.record).toHaveBeenCalledWith(db, expect.objectContaining({ workspaceId: "on", kind: "STATUS_CHANGED", before: "TODO", after: "DONE" }))
    } finally {
      vi.mocked(isModuleEnabled).mockReset()
    }
  })
  it("a narrow row with no workspace does not fail the user's write; it is logged and not captured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await expect(captureWorkspaceMutation(db, "task", "create", actor, undefined, async () => ({ id: "t" }))).resolves.toEqual({ id: "t" })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    expect(mocks.record).not.toHaveBeenCalled()
  })
})
