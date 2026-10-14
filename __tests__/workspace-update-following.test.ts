import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppPrismaClient } from "@/lib/db"
import { followableConfig } from "@/lib/followable"
import { withFollowingCommit } from "@/lib/following-commit"

const mocks = vi.hoisted(() => ({
  updatesEnabled: false,
  record: vi.fn(),
  auth: vi.fn(),
  available: vi.fn(),
  apply: vi.fn(),
}))

// withWorkspaceUpdates is replaced with the same shape the real one has when
// there is no PM receipt transaction: hand the callback a client and the flag.
vi.mock("@/lib/workspace-updates-capture", () => ({
  withWorkspaceUpdates: (db: unknown, callback: (db: unknown, enabled: boolean) => unknown) => callback(db, mocks.updatesEnabled),
  recordWorkspaceUpdate: mocks.record,
}))
vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("@/lib/db", () => ({ default: () => ({}) }))
vi.mock("@/lib/following-flag", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/following-flag")>()), followingAvailable: mocks.available }))
vi.mock("@/lib/following-hooks", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/following-hooks")>()), applyFollowingEffects: mocks.apply }))

import { captureWorkspaceMutation } from "@/lib/workspace-update-mutations"
import { runWithMcpActor } from "@/lib/mcp-authz"

const WS = "00000000-0000-4000-8000-000000000001"
const ME = "00000000-0000-4000-8000-0000000000a1"
const OTHER = "00000000-0000-4000-8000-0000000000a2"
const findUnique = vi.fn()
const db = { task: { findUnique }, opportunity: { findUnique }, solution: { findUnique }, evidence: { findUnique } } as unknown as AppPrismaClient
const user = { actorType: "USER" as const, actorId: ME }

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv("FOLLOWING_ENABLED", "1")
  mocks.updatesEnabled = false
  mocks.available.mockResolvedValue(true)
  mocks.apply.mockResolvedValue(undefined)
  followableConfig.shippedSlice = 2
})
afterEach(() => {
  followableConfig.shippedSlice = 1
  vi.unstubAllEnvs()
})

describe("status hook decoupled from WORKSPACE_UPDATES_ENABLED", () => {
  it("emits a status change with the Updates flag OFF, using the row's updatedAt for the dedupe key", async () => {
    findUnique.mockResolvedValue({ id: "t1", workspaceId: WS, status: "TODO" })
    const updatedAt = new Date("2026-10-01T10:00:00Z")
    await captureWorkspaceMutation(db, "task", "update", user, "t1", async () => ({ id: "t1", workspaceId: WS, status: "DONE", updatedAt }))
    expect(mocks.record).not.toHaveBeenCalled()
    expect(mocks.apply).toHaveBeenCalledTimes(1)
    const [effects] = mocks.apply.mock.calls[0]
    expect(effects).toEqual([expect.objectContaining({ type: "emit", event: expect.objectContaining({ kind: "STATUS_CHANGED", subjectType: "TASK", subjectId: "t1", workspaceId: WS, payload: { from: "TODO", to: "DONE" }, actor: { type: "USER", id: ME } }) })])
  })

  it("also works when the Updates flag is ON, alongside the Updates event", async () => {
    mocks.updatesEnabled = true
    findUnique.mockResolvedValue({ id: "t1", workspaceId: WS, status: "TODO" })
    await captureWorkspaceMutation(db, "task", "update", user, "t1", async () => ({ id: "t1", workspaceId: WS, status: "DONE" }))
    expect(mocks.record).toHaveBeenCalledTimes(1)
    expect(mocks.apply).toHaveBeenCalledTimes(1)
  })

  it("uses a Solution's own workspaceId, never its Opportunity's (migration 068)", async () => {
    findUnique.mockResolvedValueOnce({ id: "s1", workspaceId: WS, opportunityId: "o1", status: "IDEA" })
    await captureWorkspaceMutation(db, "solution", "update", user, "s1", async () => ({ id: "s1", workspaceId: WS, opportunityId: "o1", status: "VALIDATED" }))
    const [effects] = mocks.apply.mock.calls[0]
    expect(effects[0].event).toMatchObject({ subjectType: "SOLUTION", workspaceId: WS })
    expect(findUnique).toHaveBeenCalledTimes(1)
  })

  it("fails closed for a Solution with no workspaceId: no effect is planned and the edit still succeeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    findUnique.mockResolvedValueOnce({ id: "s1", workspaceId: null, opportunityId: "o1", status: "IDEA" })
    const result = await captureWorkspaceMutation(db, "solution", "update", user, "s1", async () => ({ id: "s1", workspaceId: null, opportunityId: "o1", status: "VALIDATED" }))
    expect(result).toMatchObject({ id: "s1" })
    expect(mocks.apply).not.toHaveBeenCalled()
    expect(findUnique).toHaveBeenCalledTimes(1)
  })

  it("does no extra read, auth, or effect when nothing changed", async () => {
    findUnique.mockResolvedValue({ id: "t1", workspaceId: WS, status: "TODO" })
    await captureWorkspaceMutation(db, "task", "update", "UI", "t1", async () => ({ id: "t1", workspaceId: WS, status: "TODO", title: "Renamed" }))
    expect(mocks.apply).not.toHaveBeenCalled()
  })

  it("keeps the pre-existing zero-cost path when FOLLOWING_ENABLED is off", async () => {
    vi.stubEnv("FOLLOWING_ENABLED", "0")
    await captureWorkspaceMutation(db, "task", "create", "UI", undefined, async () => ({ id: "t" }))
    expect(mocks.available).not.toHaveBeenCalled()
    expect(mocks.auth).not.toHaveBeenCalled()
    expect(findUnique).not.toHaveBeenCalled()
    expect(mocks.apply).not.toHaveBeenCalled()
  })

  it("does nothing for a subject type whose slice has not shipped", async () => {
    followableConfig.shippedSlice = 1
    findUnique.mockResolvedValue({ id: "t1", workspaceId: WS, status: "TODO" })
    await captureWorkspaceMutation(db, "task", "update", user, "t1", async () => ({ id: "t1", workspaceId: WS, status: "DONE" }))
    expect(mocks.apply).not.toHaveBeenCalled()
  })

  it("does nothing while the tables do not exist yet (migration not applied)", async () => {
    mocks.available.mockResolvedValue(false)
    await captureWorkspaceMutation(db, "task", "create", user, undefined, async () => ({ id: "t", workspaceId: WS }))
    expect(mocks.apply).not.toHaveBeenCalled()
  })

  it("never records effects for a rejected mutation", async () => {
    findUnique.mockResolvedValue({ id: "t1", workspaceId: WS, status: "TODO" })
    await expect(captureWorkspaceMutation(db, "task", "update", user, "t1", async () => { throw new Error("denied") })).rejects.toThrow("denied")
    expect(mocks.apply).not.toHaveBeenCalled()
  })

  it("does not fail the edit when planning effects throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    findUnique.mockResolvedValueOnce({ id: "t1", status: "TODO" })
    // The result carries no workspaceId, so resolving the scope throws inside planning.
    const result = await captureWorkspaceMutation(db, "task", "update", user, "t1", async () => ({ id: "t1", status: "DONE" }))
    expect(result).toMatchObject({ id: "t1" })
    expect(mocks.apply).not.toHaveBeenCalled()
  })
})

describe("creation and assignment", () => {
  it("auto-follows the creator of a Task", async () => {
    await captureWorkspaceMutation(db, "task", "create", user, undefined, async () => ({ id: "t1", workspaceId: WS }))
    expect(mocks.apply.mock.calls[0][0]).toEqual([{ type: "follow", target: { userId: ME, workspaceId: WS, subjectType: "TASK", subjectId: "t1" }, source: "AUTO_CREATE" }])
  })

  it("plans assignment from a before/after assignee change on an update", async () => {
    findUnique.mockResolvedValue({ id: "t1", workspaceId: WS, assigneeUserId: null, status: "TODO" })
    await captureWorkspaceMutation(db, "task", "update", user, "t1", async () => ({ id: "t1", workspaceId: WS, assigneeUserId: OTHER, status: "TODO" }))
    const kinds = mocks.apply.mock.calls[0][0].map((e: { type: string; source?: string; event?: { kind: string } }) => e.source ?? e.event?.kind)
    expect(kinds).toEqual(["AUTO_ASSIGN", "ASSIGNED"])
  })

  it("agents never follow: an MCP agent-purpose creation plans no follow, and is attributed to the agent", async () => {
    const agentId = "00000000-0000-4000-8000-0000000000c1"
    await runWithMcpActor({ purpose: "AGENT", userId: ME, agentId }, () => captureWorkspaceMutation(db, "task", "create", "MCP", undefined, async () => ({ id: "t1", workspaceId: WS, assigneeUserId: OTHER })))
    const effects = mocks.apply.mock.calls[0][0]
    expect(effects.some((e: { type: string; source?: string }) => e.type === "follow" && e.source === "AUTO_CREATE")).toBe(false)
    expect(effects.find((e: { type: string }) => e.type === "emit").event.actor).toEqual({ type: "AGENT", id: agentId })
  })

  it("a user's own MCP credential is the human actor, so they follow what they create", async () => {
    await runWithMcpActor({ purpose: "USER", userId: ME }, () => captureWorkspaceMutation(db, "task", "create", "MCP", undefined, async () => ({ id: "t1", workspaceId: WS })))
    expect(mocks.apply.mock.calls[0][0][0]).toMatchObject({ type: "follow", source: "AUTO_CREATE", target: { userId: ME } })
  })

  it("falls back to a SYSTEM actor (nobody followed or excluded) when no identity can be resolved", async () => {
    mocks.auth.mockResolvedValue(null)
    findUnique.mockResolvedValue({ id: "t1", workspaceId: WS, status: "TODO" })
    await captureWorkspaceMutation(db, "task", "update", "UI", "t1", async () => ({ id: "t1", workspaceId: WS, status: "DONE" }))
    expect(mocks.apply.mock.calls[0][0][0].event.actor).toEqual({ type: "SYSTEM", id: null })
  })
})

describe("commit-scoped delivery for MCP tools inside the PM receipt transaction", () => {
  it("defers effects until the surrounding transaction commits, and drops them on rollback", async () => {
    findUnique.mockResolvedValue({ id: "t1", workspaceId: WS, status: "TODO" })
    const events: string[] = []
    mocks.apply.mockImplementation(async () => { events.push("applied") })
    await withFollowingCommit(async () => {
      await captureWorkspaceMutation(db, "task", "update", user, "t1", async () => ({ id: "t1", workspaceId: WS, status: "DONE" }))
      events.push("transaction still open")
      expect(mocks.apply).not.toHaveBeenCalled()
    })
    expect(events).toEqual(["transaction still open", "applied"])

    mocks.apply.mockClear()
    await expect(withFollowingCommit(async () => {
      await captureWorkspaceMutation(db, "task", "update", user, "t1", async () => ({ id: "t1", workspaceId: WS, status: "DONE" }))
      throw new Error("receipt superseded")
    })).rejects.toThrow("receipt superseded")
    expect(mocks.apply).not.toHaveBeenCalled()
  })
})
