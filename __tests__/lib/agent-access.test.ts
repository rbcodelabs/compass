import { beforeEach, afterEach, expect, it, vi } from "vitest"
const prisma = { agent: { findFirst: vi.fn() }, agentWorkspaceGrant: { findMany: vi.fn() }, workspace: { findFirst: vi.fn() }, solutionComment: { findUnique: vi.fn() }, comment: { findUnique: vi.fn() }, docComment: { findUnique: vi.fn() }, decisionRecord: { findUnique: vi.fn() } }
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
it.each(["approve_solution_plan", "reject_solution_plan", "create_workspace", "unknown_tool"])("denies human-only and unclassified operation %s", async tool => {
  await expect(applyToolGate(tool, { ...actor }, {})).rejects.toThrow(/human identity/)
  expect(prisma.workspace.findFirst).not.toHaveBeenCalled()
})
// apply_recorded_decision's own registered description says "Service actors
// may apply but cannot take decisions" — unlike the human-only tools above,
// an agent must reach its gate (assertEntityAccess via decisionRecord), not
// be denied before ever touching the workspace lookup.
it("lets a service/agent identity reach apply_recorded_decision's own gate instead of denying on identity alone", async () => {
  prisma.decisionRecord.findUnique.mockResolvedValue({ workspaceId: "one" })
  prisma.workspace.findFirst.mockResolvedValue({ id: "one" })
  await expect(applyToolGate("apply_recorded_decision", { ...actor }, { decisionId: "decision-1" })).resolves.toBeUndefined()
  expect(prisma.workspace.findFirst).toHaveBeenCalled()
})
it("scopes built-in assistant reads to the initiating workspace", async () => {
  expect(await agentWorkspaceWhere({ purpose: "AGENT_TURN", userId: "owner", scopeWorkspaceId: "one" })).toEqual({ members: { some: { userId: "owner" } }, id: "one" })
})
it.each(["AGENT", "AGENT_TURN"] as const)("prevents %s from editing existing human-attributed comments or approved plans", async purpose => {
  prisma.workspace.findFirst.mockResolvedValue({ id: "one" })
  prisma.solutionComment.findUnique.mockResolvedValue({ solution: { opportunity: { workspaceId: "one" } } })
  prisma.comment.findUnique.mockResolvedValue({ workspaceId: "one" })
  // Doc comments have no body-edit tool at all (ADR 0019 removed
  // update_doc_comment outright) -- update_comment/update_solution_comment
  // are the only two of these tools left to guard.
  for (const tool of ["update_solution_comment", "update_comment"]) {
    await expect(applyToolGate(tool, { ...actor, purpose, scopeWorkspaceId: "one" }, { commentId: "comment", body: "Forged replacement" })).rejects.toThrow(/human identity/)
  }
})
