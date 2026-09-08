import { beforeEach, afterEach, expect, it, vi } from "vitest"
const prisma = { agent: { findFirst: vi.fn() }, agentWorkspaceGrant: { findMany: vi.fn() }, workspace: { findFirst: vi.fn() } }
vi.mock("@/lib/db", () => ({ default: () => prisma }))
import { agentWorkspaceWhere } from "@/lib/agent-access"
import { applyToolGate } from "@/lib/mcp-tool-gates"
const actor = { purpose: "AGENT" as const, userId: "owner", agentId: "agent" }
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("COMPASS_AGENTS_ENABLED", "1"); prisma.agent.findFirst.mockResolvedValue({ id: "agent" }); prisma.agentWorkspaceGrant.findMany.mockResolvedValue([{ workspaceId: "one" }, { workspaceId: "two" }]) })
afterEach(() => vi.unstubAllEnvs())
it("limits aggregate workspace queries to explicit grants and current membership", async () => {
  expect(await agentWorkspaceWhere(actor)).toEqual({ members: { some: { userId: "owner" } }, id: { in: ["one", "two"] } })
  expect(prisma.agentWorkspaceGrant.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { agentId: "agent", revokedAt: null, access: { in: ["READ", "WRITE"] } } }))
})
it("suspension and rollout disablement remove all workspace access", async () => {
  prisma.agent.findFirst.mockResolvedValueOnce(null)
  expect(await agentWorkspaceWhere(actor)).toEqual({ id: { in: [] } })
  vi.stubEnv("COMPASS_AGENTS_ENABLED", "0")
  expect(await agentWorkspaceWhere(actor)).toEqual({ id: { in: [] } })
})
it("requires write grants for mutation gates", async () => {
  prisma.workspace.findFirst.mockResolvedValue({ id: "one" })
  await applyToolGate("create_task", { ...actor }, { workspaceId: "one" })
  expect(prisma.agentWorkspaceGrant.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ access: "WRITE" }) }))
})
it.each(["approve_solution_plan", "reject_solution_plan", "create_workspace", "apply_recorded_decision", "unknown_tool"])("denies human-only and unclassified operation %s", async tool => {
  await expect(applyToolGate(tool, { ...actor }, {})).rejects.toThrow(/human identity/)
  expect(prisma.workspace.findFirst).not.toHaveBeenCalled()
})
it("scopes built-in assistant reads to the initiating workspace", async () => {
  expect(await agentWorkspaceWhere({ purpose: "AGENT_TURN", userId: "owner", scopeWorkspaceId: "one" })).toEqual({ members: { some: { userId: "owner" } }, id: "one" })
})
