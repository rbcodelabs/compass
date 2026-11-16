/** runAgentMayWrite (lib/agent-run-identity.ts): the WRITE bar for host-side persistence on behalf of an agent run. */
import { beforeEach, describe, expect, it, vi } from "vitest"

const agents = vi.hoisted(() => ({ findAgentById: vi.fn(), liveGrantedWorkspaceIds: vi.fn() }))
vi.mock("@/lib/agent-ownership", async () => ({ ...(await vi.importActual<object>("@/lib/agent-ownership")), findAgentById: agents.findAgentById }))
vi.mock("@/lib/agent-access", async () => ({ ...(await vi.importActual<object>("@/lib/agent-access")), liveGrantedWorkspaceIds: agents.liveGrantedWorkspaceIds }))

import { readFileSync } from "node:fs"
import { runAgentMayWrite } from "@/lib/agent-run-identity"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const run = { id: "run-1", workspaceId: "ws-1" }
const db = (findFirst: () => Promise<unknown>): Any => ({ agentRun: { findFirst: vi.fn(findFirst) } })

beforeEach(() => vi.clearAllMocks())

describe("runAgentMayWrite", () => {
  it("callers receive agentId because the shared run-authorization select carries it", () => {
    expect(readFileSync("lib/agent-runs.ts", "utf8")).toMatch(/const AGENT_RUN_AUTH_SELECT = \{[^}]*\n  agentId: true,/)
  })

  it("is true for the built-in assistant, without consulting any agent", async () => {
    expect(await runAgentMayWrite(db(async () => ({ agentId: null })), run)).toBe(true)
    expect(await runAgentMayWrite(db(async () => null), run)).toBe(true)
    expect(agents.findAgentById).not.toHaveBeenCalled()
  })

  it("short-circuits when the caller already read the run row: null is true with no query, a string skips the lookup", async () => {
    const noQuery = db(async () => { throw new Error("must not be queried") })
    expect(await runAgentMayWrite(noQuery, { ...run, agentId: null })).toBe(true)
    expect(noQuery.agentRun.findFirst).not.toHaveBeenCalled()
    agents.findAgentById.mockResolvedValue({ id: "a", status: "ACTIVE" })
    agents.liveGrantedWorkspaceIds.mockResolvedValue(["ws-other"])
    expect(await runAgentMayWrite(noQuery, { ...run, agentId: "a" })).toBe(false)
    expect(noQuery.agentRun.findFirst).not.toHaveBeenCalled()
    expect(agents.findAgentById).toHaveBeenCalledWith(expect.anything(), "a")
  })

  it("is true for an ACTIVE named agent with a live WRITE grant on the run's workspace", async () => {
    agents.findAgentById.mockResolvedValue({ id: "a", status: "ACTIVE" })
    agents.liveGrantedWorkspaceIds.mockResolvedValue(["ws-1"])
    expect(await runAgentMayWrite(db(async () => ({ agentId: "a" })), run)).toBe(true)
    expect(agents.liveGrantedWorkspaceIds).toHaveBeenCalledWith(expect.anything(), "WRITE")
  })

  it("is false without a WRITE grant on this workspace, or when the agent is missing or not ACTIVE", async () => {
    agents.findAgentById.mockResolvedValue({ id: "a", status: "ACTIVE" })
    agents.liveGrantedWorkspaceIds.mockResolvedValue(["ws-other"])
    expect(await runAgentMayWrite(db(async () => ({ agentId: "a" })), run)).toBe(false)
    agents.findAgentById.mockResolvedValue(null)
    expect(await runAgentMayWrite(db(async () => ({ agentId: "a" })), run)).toBe(false)
    agents.findAgentById.mockResolvedValue({ id: "a", status: "ARCHIVED" })
    agents.liveGrantedWorkspaceIds.mockResolvedValue(["ws-1"])
    expect(await runAgentMayWrite(db(async () => ({ agentId: "a" })), run)).toBe(false)
  })

  it("throws (fails closed) on a lookup error, except a missing schema where no named agent can exist", async () => {
    await expect(runAgentMayWrite(db(async () => { throw new Error("db down") }), run)).rejects.toThrow("db down")
    agents.findAgentById.mockRejectedValue(new Error("db down"))
    await expect(runAgentMayWrite(db(async () => ({ agentId: "a" })), run)).rejects.toThrow("db down")
    expect(await runAgentMayWrite(db(async () => { throw Object.assign(new Error("no column"), { code: "P2022" }) }), run)).toBe(true)
  })
})
