import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
const prisma = { agent: { findFirst: vi.fn() }, agentWorkspaceGrant: { findMany: vi.fn() }, workspace: { findFirst: vi.fn() }, solutionComment: { findUnique: vi.fn() }, comment: { findUnique: vi.fn() }, docComment: { findUnique: vi.fn() }, decisionRecord: { findUnique: vi.fn() }, organizationMember: { findFirst: vi.fn() }, agentOrgAdminGrant: { findFirst: vi.fn() } }
vi.mock("@/lib/db", () => ({ default: () => prisma }))
import { agentWorkspaceWhere, hasOwnerOrgAdminRights, hasValidAgentOrgAdminGrant } from "@/lib/agent-access"
import { applyToolGate } from "@/lib/mcp-tool-gates"
const actor = { purpose: "AGENT" as const, userId: "owner", agentId: "agent" }
const userAgent = { id: "agent", ownerUserId: "owner", status: "ACTIVE" }
const workspaceAgent = { id: "agent", ownerUserId: null, ownerType: "WORKSPACE", ownerWorkspaceId: "home", status: "ACTIVE" }
beforeEach(() => { vi.clearAllMocks(); prisma.organizationMember.findFirst.mockReset(); prisma.agentOrgAdminGrant.findFirst.mockReset(); vi.stubEnv("COMPASS_AGENTS_ENABLED", "1"); prisma.agent.findFirst.mockResolvedValue(userAgent); prisma.agentWorkspaceGrant.findMany.mockResolvedValue([{ workspaceId: "one" }, { workspaceId: "two" }]) })
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
it.each(["approve_solution_plan", "reject_solution_plan", "request_release_authorization", "unknown_tool"])("denies human-only and unclassified operation %s", async tool => {
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
  prisma.solutionComment.findUnique.mockResolvedValue({ solution: { workspaceId: "one" } })
  prisma.comment.findUnique.mockResolvedValue({ workspaceId: "one" })
  // Doc comments have no body-edit tool at all (ADR 0019 removed
  // update_doc_comment outright) -- update_comment/update_solution_comment
  // are the only two of these tools left to guard.
  for (const tool of ["update_solution_comment", "update_comment"]) {
    await expect(applyToolGate(tool, { ...actor, purpose, scopeWorkspaceId: "one" }, { commentId: "comment", body: "Forged replacement" })).rejects.toThrow(/human identity/)
  }
})

// Agents inherit their owner's CURRENT org admin rights (no per-agent grant).
it("hasOwnerOrgAdminRights follows the owner's live role and the agent's ACTIVE status", async () => {
  prisma.organizationMember.findFirst.mockResolvedValueOnce({ role: "ADMIN" })
  expect(await hasOwnerOrgAdminRights(actor, "org-1")).toBe(true)
  prisma.organizationMember.findFirst.mockResolvedValueOnce({ role: "MEMBER" })
  expect(await hasOwnerOrgAdminRights(actor, "org-1")).toBe(false)
  prisma.organizationMember.findFirst.mockResolvedValueOnce(null)
  expect(await hasOwnerOrgAdminRights(actor, "org-1")).toBe(false)
  prisma.agent.findFirst.mockResolvedValueOnce(null)
  prisma.organizationMember.findFirst.mockResolvedValueOnce({ role: "OWNER" })
  expect(await hasOwnerOrgAdminRights(actor, "org-1")).toBe(false)
  vi.stubEnv("COMPASS_AGENTS_ENABLED", "0")
  prisma.organizationMember.findFirst.mockResolvedValueOnce({ role: "OWNER" })
  expect(await hasOwnerOrgAdminRights(actor, "org-1")).toBe(false)
})

// ── Ownership matrix: USER-owned vs WORKSPACE-owned ──────────────────────────
it("a USER-owned agent used by a different user reaches no workspace", async () => {
  prisma.agent.findFirst.mockResolvedValueOnce({ ...userAgent, ownerUserId: "someone-else" })
  expect(await agentWorkspaceWhere(actor)).toEqual({ id: { in: [] } })
})
it("a suspended agent reaches no workspace, whatever its owner type", async () => {
  prisma.agent.findFirst.mockResolvedValueOnce({ ...workspaceAgent, status: "SUSPENDED" })
  expect(await agentWorkspaceWhere(actor)).toEqual({ id: { in: [] } })
})
it("a WORKSPACE-owned agent reaches exactly its granted workspaces (no owner comparison)", async () => {
  prisma.agent.findFirst.mockResolvedValueOnce(workspaceAgent)
  expect(await agentWorkspaceWhere(actor)).toEqual({ members: { some: { userId: "owner" } }, id: { in: ["one", "two"] } })
  expect(prisma.agentWorkspaceGrant.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ agentId: "agent", revokedAt: null }) }))
})
it("a WORKSPACE-owned agent with no grants reaches nothing", async () => {
  prisma.agent.findFirst.mockResolvedValueOnce(workspaceAgent)
  prisma.agentWorkspaceGrant.findMany.mockResolvedValueOnce([])
  expect(await agentWorkspaceWhere(actor)).toEqual({ members: { some: { userId: "owner" } }, id: { in: [] } })
})
it("a WORKSPACE-owned agent inherits NO org-admin rights, even when the user on the request is an org owner", async () => {
  prisma.agent.findFirst.mockResolvedValue(workspaceAgent)
  prisma.organizationMember.findFirst.mockResolvedValue({ role: "OWNER" })
  expect(await hasOwnerOrgAdminRights(actor, "org-1")).toBe(false)
  expect(await hasOwnerOrgAdminRights({ ...actor, userId: "home-admin" }, "org-1")).toBe(false)
})
it("a WORKSPACE-owned agent whose row still names a user is not user-owned, so it still inherits nothing", async () => {
  prisma.agent.findFirst.mockResolvedValue({ ...workspaceAgent, ownerUserId: "owner" })
  prisma.organizationMember.findFirst.mockResolvedValue({ role: "OWNER" })
  expect(await hasOwnerOrgAdminRights(actor, "org-1")).toBe(false)
})
it("a NULL owner_type (pre-098 row) is USER-owned and keeps inheriting its owner's rights", async () => {
  prisma.agent.findFirst.mockResolvedValue({ id: "agent", ownerUserId: "owner", ownerType: null, kind: null, status: "ACTIVE" })
  prisma.organizationMember.findFirst.mockResolvedValue({ role: "ADMIN" })
  expect(await hasOwnerOrgAdminRights(actor, "org-1")).toBe(true)
})

describe("hasValidAgentOrgAdminGrant", () => {
  const grant = { id: "grant-1", grantedByUserId: "human-admin" }
  it("a USER-owned agent needs a live grant whose grantor is still an org admin", async () => {
    prisma.agentOrgAdminGrant.findFirst.mockResolvedValue(grant)
    prisma.organizationMember.findFirst.mockResolvedValueOnce({ role: "ADMIN" })
    const a = { ...actor }
    expect(await hasValidAgentOrgAdminGrant(a, "org-1", "SCORING_MODEL_ADMIN")).toBe(true)
    expect(a).toMatchObject({ agentAdminGrantId: "grant-1" })
  })
  it("a USER-owned agent with no grant has no admin capability", async () => {
    prisma.agentOrgAdminGrant.findFirst.mockResolvedValue(null)
    expect(await hasValidAgentOrgAdminGrant({ ...actor }, "org-1", "SCORING_MODEL_ADMIN")).toBe(false)
  })
  it("a WORKSPACE-owned agent with a live human grant is authorized by the grant alone", async () => {
    prisma.agent.findFirst.mockResolvedValue(workspaceAgent)
    prisma.agentOrgAdminGrant.findFirst.mockResolvedValue(grant)
    prisma.organizationMember.findFirst.mockResolvedValueOnce({ role: "OWNER" })
    expect(await hasValidAgentOrgAdminGrant({ ...actor }, "org-1", "SCORING_MODEL_ADMIN")).toBe(true)
  })
  it("a WORKSPACE-owned agent loses the capability the moment the granting human is demoted", async () => {
    prisma.agent.findFirst.mockResolvedValue(workspaceAgent)
    prisma.agentOrgAdminGrant.findFirst.mockResolvedValue(grant)
    prisma.organizationMember.findFirst.mockResolvedValueOnce({ role: "MEMBER" })
    expect(await hasValidAgentOrgAdminGrant({ ...actor }, "org-1", "SCORING_MODEL_ADMIN")).toBe(false)
    prisma.organizationMember.findFirst.mockResolvedValueOnce(null)
    expect(await hasValidAgentOrgAdminGrant({ ...actor }, "org-1", "SCORING_MODEL_ADMIN")).toBe(false)
  })
  it("a WORKSPACE-owned agent with no grant has no admin capability, whoever is on the request", async () => {
    prisma.agent.findFirst.mockResolvedValue(workspaceAgent)
    prisma.agentOrgAdminGrant.findFirst.mockResolvedValue(null)
    prisma.organizationMember.findFirst.mockResolvedValue({ role: "OWNER" })
    expect(await hasValidAgentOrgAdminGrant({ ...actor }, "org-1", "SCORING_MODEL_ADMIN")).toBe(false)
  })
  it("a suspended WORKSPACE-owned agent loses a live grant", async () => {
    prisma.agent.findFirst.mockResolvedValue({ ...workspaceAgent, status: "SUSPENDED" })
    prisma.agentOrgAdminGrant.findFirst.mockResolvedValue(grant)
    prisma.organizationMember.findFirst.mockResolvedValue({ role: "OWNER" })
    expect(await hasValidAgentOrgAdminGrant({ ...actor }, "org-1", "SCORING_MODEL_ADMIN")).toBe(false)
  })
})
