import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { followableConfig } from "@/lib/followable"
import { withFollowingCommit } from "@/lib/following-commit"

const mocks = vi.hoisted(() => ({ available: vi.fn(), apply: vi.fn(), auth: vi.fn() }))
vi.mock("@/lib/db", () => ({ default: () => ({}) }))
vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("@/lib/following-flag", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/following-flag")>()), followingAvailable: mocks.available }))
vi.mock("@/lib/follows", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/follows")>()), autoFollow: mocks.apply }))

import { followAfterCreate, mcpFollowActor, sessionFollowActor } from "@/lib/following-hooks"
import { runWithMcpActor } from "@/lib/mcp-authz"

const WS = "00000000-0000-4000-8000-000000000001"
const ME = "00000000-0000-4000-8000-0000000000a1"
const OTHER = "00000000-0000-4000-8000-0000000000a2"
const AGENT = "00000000-0000-4000-8000-0000000000c1"

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv("FOLLOWING_ENABLED", "1")
  followableConfig.shippedSlice = 2
  mocks.available.mockResolvedValue(true)
  mocks.apply.mockResolvedValue({ status: "followed" })
})
afterEach(() => {
  followableConfig.shippedSlice = 1
  vi.unstubAllEnvs()
})

describe("followAfterCreate", () => {
  it("auto-follows the human creator of a Doc", async () => {
    await followAfterCreate({ model: "doc", workspaceId: WS, row: { id: "d1" }, actor: { type: "USER", id: ME } })
    expect(mocks.apply).toHaveBeenCalledWith({ userId: ME, workspaceId: WS, subjectType: "DOC", subjectId: "d1", source: "AUTO_CREATE" })
  })

  it("follows the creator and the assignee of a decision follow-up Task", async () => {
    await followAfterCreate({ model: "task", workspaceId: WS, row: { id: "t1", assigneeUserId: OTHER }, actor: { type: "USER", id: ME } })
    expect(mocks.apply.mock.calls.map(([call]) => `${call.source}:${call.userId}`)).toEqual([`AUTO_CREATE:${ME}`, `AUTO_ASSIGN:${OTHER}`])
  })

  it("never follows for an agent or a system write", async () => {
    await followAfterCreate({ model: "doc", workspaceId: WS, row: { id: "d1" }, actor: { type: "AGENT", id: AGENT } })
    await followAfterCreate({ model: "doc", workspaceId: WS, row: { id: "d1" }, actor: { type: "SYSTEM", id: null } })
    expect(mocks.apply).not.toHaveBeenCalled()
  })

  it("is silent with the flag off, before the tables exist, or for unknown models", async () => {
    vi.stubEnv("FOLLOWING_ENABLED", "0")
    await followAfterCreate({ model: "doc", workspaceId: WS, row: { id: "d1" }, actor: { type: "USER", id: ME } })
    vi.stubEnv("FOLLOWING_ENABLED", "1")
    mocks.available.mockResolvedValue(false)
    await followAfterCreate({ model: "doc", workspaceId: WS, row: { id: "d1" }, actor: { type: "USER", id: ME } })
    mocks.available.mockResolvedValue(true)
    await followAfterCreate({ model: "evidence", workspaceId: WS, row: { id: "x" }, actor: { type: "USER", id: ME } })
    expect(mocks.apply).not.toHaveBeenCalled()
  })

  it("never throws, even when the availability probe does", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.available.mockRejectedValue(new Error("probe down"))
    await expect(followAfterCreate({ model: "doc", workspaceId: WS, row: { id: "d1" }, actor: { type: "USER", id: ME } })).resolves.toBeUndefined()
  })

  it("waits for the commit scope when one is open", async () => {
    await withFollowingCommit(async () => {
      await followAfterCreate({ model: "doc", workspaceId: WS, row: { id: "d1" }, actor: { type: "USER", id: ME } })
      expect(mocks.apply).not.toHaveBeenCalled()
    })
    expect(mocks.apply).toHaveBeenCalledTimes(1)
  })
})

describe("actor helpers", () => {
  it("mcpFollowActor maps credentials and is null outside an MCP request", () => {
    expect(mcpFollowActor()).toBeNull()
    expect(runWithMcpActor({ purpose: "USER", userId: ME }, () => mcpFollowActor())).toEqual({ type: "USER", id: ME })
    expect(runWithMcpActor({ purpose: "AGENT", userId: ME, agentId: AGENT }, () => mcpFollowActor())).toEqual({ type: "AGENT", id: AGENT })
    expect(runWithMcpActor({ purpose: "RESEARCH", userId: ME }, () => mcpFollowActor())).toEqual({ type: "SYSTEM", id: null })
  })

  it("sessionFollowActor reads the signed-in user and falls back to SYSTEM", async () => {
    mocks.auth.mockResolvedValue({ user: { id: ME } })
    expect(await sessionFollowActor()).toEqual({ type: "USER", id: ME })
    mocks.auth.mockResolvedValue(null)
    expect(await sessionFollowActor()).toEqual({ type: "SYSTEM", id: null })
    mocks.auth.mockRejectedValue(new Error("no request scope"))
    expect(await sessionFollowActor()).toEqual({ type: "SYSTEM", id: null })
  })
})
