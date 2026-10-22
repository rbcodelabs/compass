/**
 * Run-as-agent authorization (ADR "Cloud agents as first-class identities", phase 2).
 *
 * These drive the REAL validateMcpAuth, agent-access, mcp-authz, agent-mcp-key and agent-activity modules over a small
 * in-memory database, so the negative cases below are decided by the production predicates, not by mock call
 * assertions: a stale grantor, a different agent's run, an expired or terminal run, another workspace, another
 * organization, and a USER-owned agent invoked by someone other than its owner each have to fail closed.
 */
import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>

const db = vi.hoisted(() => ({
  state: {} as Record<string, Row[]>,
  created: [] as Row[],
}))

/** Evaluates the small subset of Prisma `where` the production code uses on these tables. */
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true
  return Object.entries(where).every(([key, condition]) => {
    if (key === "AND") return (condition as Row[]).every((part) => matches(row, part))
    if (key === "OR") return (condition as Row[]).some((part) => matches(row, part))
    const value = row[key]
    if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
      if ("in" in condition) return (condition.in as unknown[]).includes(value)
      if ("gt" in condition) return value instanceof Date && value.getTime() > (condition.gt as Date).getTime()
      if ("not" in condition) return value !== condition.not
      return false
    }
    return value === condition
  })
}

const table = (name: string) => ({
  findFirst: vi.fn(async ({ where, select }: Row) => {
    const row = (db.state[name] ?? []).find((candidate) => matches(candidate, where))
    return row ? (select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : row) : null
  }),
  findMany: vi.fn(async ({ where }: Row) => (db.state[name] ?? []).filter((candidate) => matches(candidate, where))),
})

const prisma: Row = {
  apiKey: {
    ...table("apiKey"),
    update: vi.fn(async () => ({})),
    create: vi.fn(async ({ data }: Row) => { db.created.push(data); return { id: "new-key" } }),
  },
  agent: table("agent"),
  user: table("user"),
  agentRun: table("agentRun"),
  agentWorkspaceGrant: table("agentWorkspaceGrant"),
  workspaceDefaultAgent: table("workspaceDefaultAgent"),
  userDefaultAgent: table("userDefaultAgent"),
  agentOrgAdminGrant: table("agentOrgAdminGrant"),
  agentToolCall: { create: vi.fn(async ({ data }: Row) => { db.created.push({ toolCall: data }); return { id: "call-1" } }), update: vi.fn(async () => ({})) },
  workspaceMember: table("workspaceMember"),
  organizationMember: table("organizationMember"),
  organization: { findUnique: vi.fn(async ({ where }: Row) => (db.state.organization ?? []).find((o) => o.slug === where.slug) ?? null) },
  workspace: {
    findFirst: vi.fn(async ({ where, select }: Row) => {
      const ws = (db.state.workspace ?? []).find((w) => matches(w, where))
      if (!ws) return null
      const userOf = (s: Row | undefined) => s?.where?.userId
      return {
        id: ws.id,
        organizationId: ws.organizationId,
        members: (db.state.workspaceMember ?? []).filter((m) => m.workspaceId === ws.id && m.userId === userOf(select?.members)),
        organization: { members: (db.state.organizationMember ?? []).filter((m) => m.organizationId === ws.organizationId && m.userId === userOf(select?.organization?.select?.members)) },
      }
    }),
    findUnique: vi.fn(async ({ where }: Row) => (db.state.workspace ?? []).find((w) => w.id === where.id) ?? null),
  },
}
vi.mock("@/lib/db", () => ({ default: () => prisma }))

import { validateMcpAuth } from "@/lib/mcp-auth"
import { agentWorkspaceWhere, hasOwnerOrgAdminRights, hasValidAgentOrgAdminGrant } from "@/lib/agent-access"
import { assertOrgAdminBySlug, assertOrgMemberBySlug, assertWorkspaceAdmin, type McpActor } from "@/lib/mcp-authz"
import { mintAgentMcpKey } from "@/lib/agent-mcp-key"
import { invokedByForAgentActivity, withAgentActivity } from "@/lib/agent-activity"
import { agentIdentityValidForTurn, resetAgentColumnsAvailabilityCache } from "@/lib/agent-ownership"
import { resetAgentDefaultsAvailabilityCache } from "@/lib/agent-defaults"
import { AgentSelectionError, LIVE_AGENT_RUN_STATUSES, listRunnableAgents, resolveRunAgent } from "@/lib/agent-run-identity"
import { NON_TERMINAL_AGENT_RUN_STATUSES } from "@/lib/agent-runs"

const FUTURE = new Date(Date.now() + 10 * 60_000)
const PAST = new Date(Date.now() - 60_000)
const TOKEN = `cmp_${"c".repeat(32)}`
const request = () => new Request("https://compass.test/api/mcp", { headers: { authorization: `Bearer ${TOKEN}` } })

const HOME = "ws-home"
const OTHER_WS = "ws-other"
const ORG = "org-1"
const OTHER_ORG = "org-2"

const sharedAgent = { id: "agent-shared", ownerUserId: null, ownerType: "WORKSPACE", ownerWorkspaceId: HOME, kind: "CLOUD", status: "ACTIVE", name: "Shared", invokePolicy: null }
const personalAgent = { id: "agent-personal", ownerUserId: "owner", ownerType: "USER", ownerWorkspaceId: null, kind: "CLOUD", status: "ACTIVE", name: "Personal", invokePolicy: null }

function turnKey(overrides: Row = {}): Row {
  return { id: "key-1", keyPrefix: "c".repeat(8), keyHash: createHash("sha256").update(TOKEN).digest("hex"), revokedAt: null, userId: "invoker", purpose: "AGENT_TURN", agentId: sharedAgent.id, scopeWorkspaceId: HOME, scopeConversationId: null, scopeClaimId: null, expiresAt: FUTURE, ...overrides }
}
function liveRun(overrides: Row = {}): Row {
  return { id: "run-1", apiKeyId: "key-1", agentId: sharedAgent.id, workspaceId: HOME, userId: "invoker", invokedByUserId: "invoker", status: "RUNNING", deadlineAt: FUTURE, ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetAgentColumnsAvailabilityCache()
  resetAgentDefaultsAvailabilityCache()
  db.created.length = 0
  db.state = {
    apiKey: [turnKey()],
    agent: [{ ...sharedAgent }, { ...personalAgent }],
    agentRun: [liveRun()],
    agentWorkspaceGrant: [{ agentId: sharedAgent.id, workspaceId: HOME, access: "WRITE", revokedAt: null, grantedByUserId: "admin" }],
    agentOrgAdminGrant: [],
    workspace: [{ id: HOME, organizationId: ORG }, { id: OTHER_WS, organizationId: ORG }],
    workspaceMember: [{ workspaceId: HOME, userId: "admin", role: "ADMIN" }, { workspaceId: HOME, userId: "invoker", role: "MEMBER" }, { workspaceId: HOME, userId: "owner", role: "MEMBER" }],
    organizationMember: [{ organizationId: ORG, userId: "admin", role: "ADMIN" }, { organizationId: ORG, userId: "invoker", role: "MEMBER" }, { organizationId: ORG, userId: "owner", role: "MEMBER" }],
    organization: [{ id: ORG, slug: "acme" }, { id: OTHER_ORG, slug: "other" }],
  }
})
afterEach(() => vi.unstubAllEnvs())

async function authenticate(): Promise<McpActor> {
  const auth = await validateMcpAuth(request())
  if (!auth.valid) throw new Error("expected a valid credential")
  return { userId: auth.userId, purpose: auth.purpose, agentId: auth.agentId, credentialId: auth.credentialId, credentialType: auth.credentialType, agentRunId: auth.agentRunId, scopeWorkspaceId: auth.scopeWorkspaceId }
}

describe("validateMcpAuth for an agent-scoped AGENT_TURN key", () => {
  it("accepts a key tied to a live run of that exact WORKSPACE-owned agent and carries the run", async () => {
    await expect(validateMcpAuth(request())).resolves.toMatchObject({ valid: true, purpose: "AGENT_TURN", userId: "invoker", agentId: sharedAgent.id, agentRunId: "run-1", credentialId: "key-1", scopeWorkspaceId: HOME })
  })

  it.each(["SUCCEEDED", "FAILED", "CANCELED", "INTERRUPTED"])("rejects the key once its run is %s", async (status) => {
    db.state.agentRun = [liveRun({ status })]
    await expect(validateMcpAuth(request())).resolves.toEqual({ valid: false })
  })

  it("accepts a QUEUED run (the key is attached before the sandbox boots)", async () => {
    db.state.agentRun = [liveRun({ status: "QUEUED" })]
    await expect(validateMcpAuth(request())).resolves.toMatchObject({ valid: true, agentRunId: "run-1" })
  })

  it("rejects the key when the run's deadline has passed", async () => {
    db.state.agentRun = [liveRun({ deadlineAt: PAST })]
    await expect(validateMcpAuth(request())).resolves.toEqual({ valid: false })
  })

  it("rejects a key for agent A that is attached to a run of agent B (wrong agent)", async () => {
    db.state.agentRun = [liveRun({ agentId: personalAgent.id })]
    await expect(validateMcpAuth(request())).resolves.toEqual({ valid: false })
  })

  it("rejects a key whose run is in another workspace than the key's scope (cross-workspace)", async () => {
    db.state.agentRun = [liveRun({ workspaceId: OTHER_WS })]
    await expect(validateMcpAuth(request())).resolves.toEqual({ valid: false })
  })

  it("rejects a key that no run names (a key cannot borrow another run)", async () => {
    db.state.agentRun = [liveRun({ apiKeyId: "someone-elses-key" })]
    await expect(validateMcpAuth(request())).resolves.toEqual({ valid: false })
  })

  it("rejects a key whose run was started by a different invoker", async () => {
    db.state.agentRun = [liveRun({ invokedByUserId: "someone-else" })]
    await expect(validateMcpAuth(request())).resolves.toEqual({ valid: false })
  })

  it("rejects a key with no run at all", async () => {
    db.state.agentRun = []
    await expect(validateMcpAuth(request())).resolves.toEqual({ valid: false })
  })

  it.each([
    ["suspended", { status: "SUSPENDED" }],
    ["an EXTERNAL agent (not a cloud agent)", { kind: "EXTERNAL" }],
    ["a legacy row with no kind", { kind: null }],
    ["an inconsistent WORKSPACE row with no workspace", { ownerWorkspaceId: null }],
  ])("rejects a key for an agent that is %s", async (_label, patch) => {
    db.state.agent = [{ ...sharedAgent, ...patch }]
    await expect(validateMcpAuth(request())).resolves.toEqual({ valid: false })
  })

  it("fails closed when the run lookup itself errors (migration 100 unapplied)", async () => {
    prisma.agentRun.findFirst.mockRejectedValueOnce(Object.assign(new Error("column agent_id does not exist"), { code: "P2022" }))
    await expect(validateMcpAuth(request())).resolves.toEqual({ valid: false })
  })

  it("USER-owned cloud agent: accepted for its owner, rejected for anyone else (invoked by a non-owner)", async () => {
    db.state.agent = [{ ...personalAgent }]
    db.state.agentRun = [liveRun({ agentId: personalAgent.id, userId: "owner", invokedByUserId: "owner" })]
    db.state.apiKey = [turnKey({ agentId: personalAgent.id, userId: "owner" })]
    await expect(validateMcpAuth(request())).resolves.toMatchObject({ valid: true, agentId: personalAgent.id, userId: "owner" })

    db.state.agentRun = [liveRun({ agentId: personalAgent.id })]
    db.state.apiKey = [turnKey({ agentId: personalAgent.id, userId: "invoker" })]
    await expect(validateMcpAuth(request())).resolves.toEqual({ valid: false })
  })

  it("a legacy AGENT_TURN key with no agent is unchanged: valid, no run, not an agent identity", async () => {
    db.state.apiKey = [turnKey({ agentId: null })]
    db.state.agentRun = []
    const auth = await validateMcpAuth(request())
    expect(auth).toMatchObject({ valid: true, purpose: "AGENT_TURN", agentId: null })
    expect((auth as Row).agentRunId).toBeUndefined()
  })

  it("an agent id on a USER or RESEARCH key is still rejected", async () => {
    db.state.apiKey = [turnKey({ purpose: "USER" })]
    await expect(validateMcpAuth(request())).resolves.toEqual({ valid: false })
    db.state.apiKey = [turnKey({ purpose: "RESEARCH" })]
    await expect(validateMcpAuth(request())).resolves.toEqual({ valid: false })
  })

  it("a personal AGENT key still cannot reach a WORKSPACE-owned agent", async () => {
    db.state.apiKey = [turnKey({ purpose: "AGENT", expiresAt: null })]
    await expect(validateMcpAuth(request())).resolves.toEqual({ valid: false })
  })
})

describe("what a shared agent can reach", () => {
  it("is exactly its live grants in the owning workspace, with no membership clause from the invoker", async () => {
    const actor = await authenticate()
    expect(await agentWorkspaceWhere(actor)).toEqual({ id: { in: [HOME] } })
  })

  it("never reaches a workspace other than the one that owns it, even with a live grant there", async () => {
    db.state.agentWorkspaceGrant.push({ agentId: sharedAgent.id, workspaceId: OTHER_WS, access: "WRITE", revokedAt: null, grantedByUserId: "admin" })
    const actor = await authenticate()
    expect(await agentWorkspaceWhere(actor)).toEqual({ id: { in: [HOME] } })
  })

  it("loses a grant when the admin who issued it is no longer an admin (stale grantor)", async () => {
    const actor = await authenticate()
    db.state.workspaceMember = db.state.workspaceMember.map((m) => (m.userId === "admin" ? { ...m, role: "MEMBER" } : m))
    db.state.organizationMember = db.state.organizationMember.map((m) => (m.userId === "admin" ? { ...m, role: "MEMBER" } : m))
    expect(await agentWorkspaceWhere(actor)).toEqual({ id: { in: [] } })
  })

  it("keeps a grant whose issuer is an org admin who is not a member of the workspace", async () => {
    db.state.agentWorkspaceGrant[0].grantedByUserId = "org-admin"
    db.state.organizationMember.push({ organizationId: ORG, userId: "org-admin", role: "OWNER" })
    const actor = await authenticate()
    expect(await agentWorkspaceWhere(actor)).toEqual({ id: { in: [HOME] } })
  })

  it("ignores revoked grants and honours the required access level", async () => {
    db.state.agentWorkspaceGrant[0].access = "READ"
    const actor = await authenticate()
    expect(await agentWorkspaceWhere({ ...actor, requiredAgentAccess: "READ" })).toEqual({ id: { in: [HOME] } })
    expect(await agentWorkspaceWhere({ ...actor, requiredAgentAccess: "WRITE" })).toEqual({ id: { in: [] } })
    db.state.agentWorkspaceGrant[0].revokedAt = new Date()
    expect(await agentWorkspaceWhere({ ...actor, requiredAgentAccess: "READ" })).toEqual({ id: { in: [] } })
  })

  it("is empty when the actor carries no run (an AGENT_TURN agentId alone is never enough)", async () => {
    const actor = await authenticate()
    expect(await agentWorkspaceWhere({ ...actor, agentRunId: undefined })).toEqual({ id: { in: [] } })
  })

  it("is empty when the workspace scope of the key is another workspace than any grant", async () => {
    const actor = await authenticate()
    expect(await agentWorkspaceWhere({ ...actor, scopeWorkspaceId: OTHER_WS })).toEqual({ id: { in: [] } })
  })

  it("a USER-owned cloud agent is its grants INTERSECTED with the owner's membership", async () => {
    db.state.agent = [{ ...personalAgent }]
    db.state.agentWorkspaceGrant = [{ agentId: personalAgent.id, workspaceId: HOME, access: "WRITE", revokedAt: null, grantedByUserId: "owner" }]
    const actor: McpActor = { userId: "owner", purpose: "AGENT_TURN", agentId: personalAgent.id, agentRunId: "run-1", scopeWorkspaceId: HOME }
    expect(await agentWorkspaceWhere(actor)).toEqual({ members: { some: { userId: "owner" } }, id: { in: [HOME] } })
  })

  it("the legacy built-in turn is unchanged: membership plus the key's workspace", async () => {
    expect(await agentWorkspaceWhere({ userId: "invoker", purpose: "AGENT_TURN", scopeWorkspaceId: HOME })).toEqual({ members: { some: { userId: "invoker" } }, id: HOME })
  })
})

describe("a shared agent and org-admin actions", () => {
  const capability = "SCORING_MODEL_ADMIN" as const

  it("cannot perform an org-admin action with no admin grant", async () => {
    const actor = await authenticate()
    await expect(assertWorkspaceAdmin(actor, HOME)).rejects.toThrow(/Human administrator required/)
    await expect(assertWorkspaceAdmin(actor, HOME, { agentCapability: capability })).rejects.toThrow(/Human administrator required/)
    expect(await hasValidAgentOrgAdminGrant(actor, ORG, capability)).toBe(false)
  })

  it("cannot inherit its invoker's or any owner's org-admin rights", async () => {
    db.state.organizationMember = db.state.organizationMember.map((m) => (m.userId === "invoker" ? { ...m, role: "OWNER" } : m))
    const actor = await authenticate()
    expect(await hasOwnerOrgAdminRights(actor, ORG)).toBe(false)
    await expect(assertOrgAdminBySlug(actor, "acme", { inheritOwnerAdmin: true })).rejects.toThrow(/Human administrator required/)
  })

  it("can act under a live grant issued by a CURRENT org admin, and records which grant", async () => {
    db.state.agentOrgAdminGrant = [{ id: "grant-1", agentId: sharedAgent.id, organizationId: ORG, capability, revokedAt: null, grantedByUserId: "admin" }]
    const actor = await authenticate()
    await expect(assertWorkspaceAdmin(actor, HOME, { agentCapability: capability })).resolves.toBeUndefined()
    expect(actor.agentAdminGrantId).toBe("grant-1")
  })

  it("loses the grant when its issuer is demoted (time-of-check, not time-of-grant)", async () => {
    db.state.agentOrgAdminGrant = [{ id: "grant-1", agentId: sharedAgent.id, organizationId: ORG, capability, revokedAt: null, grantedByUserId: "admin" }]
    db.state.organizationMember = db.state.organizationMember.map((m) => (m.userId === "admin" ? { ...m, role: "MEMBER" } : m))
    const actor = await authenticate()
    await expect(assertWorkspaceAdmin(actor, HOME, { agentCapability: capability })).rejects.toThrow(/Human administrator required/)
  })

  it("ignores a revoked grant", async () => {
    db.state.agentOrgAdminGrant = [{ id: "grant-1", agentId: sharedAgent.id, organizationId: ORG, capability, revokedAt: new Date(), grantedByUserId: "admin" }]
    const actor = await authenticate()
    expect(await hasValidAgentOrgAdminGrant(actor, ORG, capability)).toBe(false)
  })

  it("cannot use a grant in a different organization than the one that owns its workspace", async () => {
    db.state.agentOrgAdminGrant = [{ id: "grant-2", agentId: sharedAgent.id, organizationId: OTHER_ORG, capability, revokedAt: null, grantedByUserId: "admin" }]
    db.state.organizationMember.push({ organizationId: OTHER_ORG, userId: "admin", role: "ADMIN" })
    const actor = await authenticate()
    expect(await hasValidAgentOrgAdminGrant(actor, OTHER_ORG, capability)).toBe(false)
  })

  it("sees only its own organization through org membership reads, not its invoker's other organizations", async () => {
    db.state.organizationMember.push({ organizationId: OTHER_ORG, userId: "invoker", role: "MEMBER" })
    const actor = await authenticate()
    await expect(assertOrgMemberBySlug(actor, "acme")).resolves.toEqual({ organizationId: ORG })
    await expect(assertOrgMemberBySlug(actor, "other")).rejects.toThrow(/not found or access denied/)
  })

  it("a shared agent reads its organization even when its invoker is not an org member", async () => {
    db.state.organizationMember = db.state.organizationMember.filter((m) => m.userId !== "invoker")
    const actor = await authenticate()
    await expect(assertOrgMemberBySlug(actor, "acme")).resolves.toEqual({ organizationId: ORG })
  })
})

describe("mintAgentMcpKey with an agent", () => {
  it("mints an AGENT_TURN key that carries the agent id, scoped to the workspace", async () => {
    await mintAgentMcpKey("invoker", HOME, undefined, FUTURE, { agentId: sharedAgent.id })
    expect(db.created[0]).toMatchObject({ userId: "invoker", purpose: "AGENT_TURN", agentId: sharedAgent.id, scopeWorkspaceId: HOME, expiresAt: FUTURE })
  })

  it("a built-in mint (no agent) is unchanged and carries no agent id", async () => {
    await mintAgentMcpKey("invoker", HOME, undefined, FUTURE)
    expect(db.created[0]).toMatchObject({ purpose: "AGENT_TURN", scopeWorkspaceId: HOME })
    expect(db.created[0]).not.toHaveProperty("agentId")
  })

  it.each([
    ["an agent with no live grant in the workspace", () => { db.state.agentWorkspaceGrant = [] }],
    ["a revoked grant", () => { db.state.agentWorkspaceGrant[0].revokedAt = new Date() }],
    ["a grant whose issuer is no longer an admin (stale grantor)", () => { db.state.workspaceMember = db.state.workspaceMember.map((m) => (m.userId === "admin" ? { ...m, role: "MEMBER" } : m)); db.state.organizationMember = db.state.organizationMember.filter((m) => m.userId !== "admin") }],
    ["a suspended agent", () => { db.state.agent[0].status = "SUSPENDED" }],
    ["an EXTERNAL agent", () => { db.state.agent[0].kind = "EXTERNAL" }],
    ["a shared agent in a workspace other than its own", () => { db.state.agentWorkspaceGrant.push({ agentId: sharedAgent.id, workspaceId: OTHER_WS, access: "WRITE", revokedAt: null, grantedByUserId: "admin" }) }],
  ])("refuses %s", async (label, arrange) => {
    arrange()
    const workspaceId = label.includes("other than its own") ? OTHER_WS : HOME
    await expect(mintAgentMcpKey("invoker", workspaceId, undefined, FUTURE, { agentId: sharedAgent.id })).rejects.toThrow(/Agent/)
    expect(prisma.apiKey.create).not.toHaveBeenCalled()
  })

  it("refuses a USER-owned agent for anyone but its owner", async () => {
    db.state.agentWorkspaceGrant = [{ agentId: personalAgent.id, workspaceId: HOME, access: "WRITE", revokedAt: null, grantedByUserId: "owner" }]
    await expect(mintAgentMcpKey("invoker", HOME, undefined, FUTURE, { agentId: personalAgent.id })).rejects.toThrow(/not available/)
    await expect(mintAgentMcpKey("owner", HOME, undefined, FUTURE, { agentId: personalAgent.id })).resolves.toMatchObject({ apiKeyId: "new-key" })
  })

})

describe("activity logging for cloud runs", () => {
  it("records a mutation made by a run's key with the agent and the invoking user", async () => {
    const actor = { ...(await authenticate()), credentialId: "key-1" }
    await withAgentActivity(actor, "update_task", true, async () => {}, async () => ({ ok: true }))
    expect(db.created.find((c) => c.toolCall)?.toolCall).toMatchObject({ agentId: sharedAgent.id, userId: "invoker", credentialId: "key-1", credentialType: "API_KEY", toolName: "update_task", status: "STARTED" })
  })

  it("does not log reads, and does not log a built-in (agentless) turn", async () => {
    const actor = { ...(await authenticate()), credentialId: "key-1" }
    await withAgentActivity(actor, "list_tasks", false, async () => {}, async () => ({}))
    await withAgentActivity({ userId: "invoker", purpose: "AGENT_TURN", credentialId: "key-9" }, "update_task", true, async () => {}, async () => ({}))
    expect(prisma.agentToolCall.create).not.toHaveBeenCalled()
  })
})

describe("resolveRunAgent (who may start a run as which agent)", () => {
  const resolve = (userId: string, workspaceId: string, requestedAgentId?: string | null) => resolveRunAgent(prisma as never, { userId, workspaceId, requestedAgentId })
  const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error) => error as AgentSelectionError)

  it("returns null for the built-in assistant when no agent is requested", async () => {
    expect(await resolve("invoker", HOME)).toBeNull()
    expect(await resolve("invoker", HOME, null)).toBeNull()
  })

  it("lets any workspace member run a shared agent whose policy is WORKSPACE_MEMBERS (the default)", async () => {
    await expect(resolve("invoker", HOME, sharedAgent.id)).resolves.toMatchObject({ id: sharedAgent.id })
  })

  it("lets only admins run a shared agent whose policy is ADMINS or OWNER", async () => {
    for (const invokePolicy of ["ADMINS", "OWNER"]) {
      db.state.agent = [{ ...sharedAgent, invokePolicy }]
      expect(await refusal(resolve("invoker", HOME, sharedAgent.id))).toMatchObject({ status: 403, code: "AGENT_NOT_INVOKABLE" })
      await expect(resolve("admin", HOME, sharedAgent.id)).resolves.toMatchObject({ id: sharedAgent.id })
    }
  })

  it("refuses a non-member of a shared agent's workspace", async () => {
    expect(await refusal(resolve("stranger", HOME, sharedAgent.id))).toMatchObject({ status: 403, code: "AGENT_NOT_INVOKABLE" })
  })

  it("refuses a USER-owned agent invoked by anyone but its owner", async () => {
    db.state.agentWorkspaceGrant = [{ agentId: personalAgent.id, workspaceId: HOME, access: "WRITE", revokedAt: null, grantedByUserId: "owner" }]
    expect(await refusal(resolve("invoker", HOME, personalAgent.id))).toMatchObject({ status: 403, code: "AGENT_NOT_INVOKABLE" })
    expect(await refusal(resolve("admin", HOME, personalAgent.id))).toMatchObject({ status: 403, code: "AGENT_NOT_INVOKABLE" })
    await expect(resolve("owner", HOME, personalAgent.id)).resolves.toMatchObject({ id: personalAgent.id })
  })

  it.each([
    ["an unknown id", () => { db.state.agent = [] }],
    ["a suspended agent", () => { db.state.agent[0].status = "SUSPENDED" }],
    ["an EXTERNAL (key based) agent", () => { db.state.agent[0].kind = "EXTERNAL" }],
    ["an agent with no live grant in this workspace", () => { db.state.agentWorkspaceGrant = [] }],
    ["a grant whose issuer is no longer an admin (stale grantor)", () => { db.state.workspaceMember = db.state.workspaceMember.filter((m) => m.userId !== "admin"); db.state.organizationMember = db.state.organizationMember.filter((m) => m.userId !== "admin") }],
  ])("answers 404 for %s, revealing nothing", async (_label, arrange) => {
    arrange()
    expect(await refusal(resolve("invoker", HOME, sharedAgent.id))).toMatchObject({ status: 404, code: "AGENT_NOT_FOUND" })
  })

  it("answers 404 for a shared agent used in a workspace other than its own (cross-workspace)", async () => {
    db.state.agentWorkspaceGrant.push({ agentId: sharedAgent.id, workspaceId: OTHER_WS, access: "WRITE", revokedAt: null, grantedByUserId: "admin" })
    db.state.workspaceMember.push({ workspaceId: OTHER_WS, userId: "invoker", role: "MEMBER" })
    expect(await refusal(resolve("invoker", OTHER_WS, sharedAgent.id))).toMatchObject({ status: 404, code: "AGENT_NOT_FOUND" })
  })

})

describe("resolveRunAgent default chain (explicit > user default > workspace default > built-in)", () => {
  const resolve = (userId: string, workspaceId: string, requestedAgentId?: string | null) => resolveRunAgent(prisma as never, { userId, workspaceId, requestedAgentId })
  const secondShared = { ...sharedAgent, id: "agent-shared-2", name: "Second shared" }
  beforeEach(() => {
    db.state.agent.push({ ...secondShared })
    db.state.agentWorkspaceGrant.push({ agentId: secondShared.id, workspaceId: HOME, access: "READ", revokedAt: null, grantedByUserId: "admin" })
    db.state.agentWorkspaceGrant.push({ agentId: personalAgent.id, workspaceId: HOME, access: "READ", revokedAt: null, grantedByUserId: "admin" })
  })
  const setWorkspaceDefault = (agentId: string) => { db.state.workspaceDefaultAgent = [{ workspaceId: HOME, agentId }] }
  const setUserDefault = (userId: string, agentId: string) => { db.state.userDefaultAgent = [{ userId, workspaceId: HOME, agentId }] }

  it("is the built-in agent when no default is set", async () => {
    expect(await resolve("invoker", HOME)).toBeNull()
  })

  it("uses the workspace default when the user has none", async () => {
    setWorkspaceDefault(sharedAgent.id)
    await expect(resolve("invoker", HOME)).resolves.toMatchObject({ id: sharedAgent.id })
  })

  it("prefers the user's own default over the workspace default", async () => {
    setWorkspaceDefault(sharedAgent.id)
    setUserDefault("invoker", secondShared.id)
    await expect(resolve("invoker", HOME)).resolves.toMatchObject({ id: secondShared.id })
    // Another member still gets the workspace default: the override is personal.
    await expect(resolve("owner", HOME)).resolves.toMatchObject({ id: sharedAgent.id })
  })

  it("lets an explicit pick beat both defaults, and 'builtin' opt out of them", async () => {
    setWorkspaceDefault(sharedAgent.id)
    setUserDefault("invoker", secondShared.id)
    await expect(resolve("invoker", HOME, sharedAgent.id)).resolves.toMatchObject({ id: sharedAgent.id })
    expect(await resolve("invoker", HOME, "builtin")).toBeNull()
  })

  it("lets a user default their own USER-owned agent", async () => {
    setUserDefault("owner", personalAgent.id)
    await expect(resolve("owner", HOME)).resolves.toMatchObject({ id: personalAgent.id })
  })

  it.each([
    ["suspended", () => { db.state.agent.find((a) => a.id === secondShared.id)!.status = "SUSPENDED" }],
    ["deleted", () => { db.state.agent = db.state.agent.filter((a) => a.id !== secondShared.id) }],
    ["no longer granted in this workspace", () => { db.state.agentWorkspaceGrant = db.state.agentWorkspaceGrant.filter((g) => g.agentId !== secondShared.id) }],
    ["a grant revoked", () => { db.state.agentWorkspaceGrant.find((g) => g.agentId === secondShared.id)!.revokedAt = PAST }],
  ])("silently falls through a stale user default (%s) to the workspace default", async (_label, arrange) => {
    setWorkspaceDefault(sharedAgent.id)
    setUserDefault("invoker", secondShared.id)
    arrange()
    await expect(resolve("invoker", HOME)).resolves.toMatchObject({ id: sharedAgent.id })
  })

  it("falls through a stale default all the way to the built-in agent without throwing", async () => {
    setWorkspaceDefault(sharedAgent.id)
    setUserDefault("invoker", secondShared.id)
    db.state.agent.forEach((a) => { a.status = "SUSPENDED" })
    expect(await resolve("invoker", HOME)).toBeNull()
  })

  it("ignores a default the user is no longer allowed to invoke (someone else's USER-owned agent, or an admins-only agent)", async () => {
    setUserDefault("invoker", personalAgent.id)
    expect(await resolve("invoker", HOME)).toBeNull()
    db.state.userDefaultAgent = []
    db.state.agent.find((a) => a.id === sharedAgent.id)!.invokePolicy = "ADMINS"
    setWorkspaceDefault(sharedAgent.id)
    expect(await resolve("invoker", HOME)).toBeNull()
    await expect(resolve("admin", HOME)).resolves.toMatchObject({ id: sharedAgent.id })
  })

  it("never applies another workspace's default", async () => {
    db.state.workspaceDefaultAgent = [{ workspaceId: OTHER_WS, agentId: sharedAgent.id }]
    expect(await resolve("invoker", HOME)).toBeNull()
  })

  it("tolerates migration 101 being unapplied: no default, built-in agent", async () => {
    const missing = Object.assign(new Error("The table does not exist"), { code: "P2021" })
    prisma.workspaceDefaultAgent.findFirst.mockRejectedValueOnce(missing)
    prisma.userDefaultAgent.findFirst.mockRejectedValueOnce(missing)
    expect(await resolve("invoker", HOME)).toBeNull()
  })

  it("rethrows any other database fault rather than silently running the wrong agent", async () => {
    prisma.workspaceDefaultAgent.findFirst.mockRejectedValueOnce(new Error("connection reset"))
    await expect(resolve("invoker", HOME)).rejects.toThrow(/connection reset/)
  })
})

describe("listRunnableAgents (what the pickers offer)", () => {
  it("offers only agents the member could pick, and names the resolved default", async () => {
    const suspended = { ...sharedAgent, id: "agent-suspended", status: "SUSPENDED", name: "Zed" }
    const adminsOnly = { ...sharedAgent, id: "agent-admins", invokePolicy: "ADMINS", name: "Admins" }
    const external = { ...sharedAgent, id: "agent-external", kind: "EXTERNAL", name: "Ext" }
    db.state.agent.push(suspended, adminsOnly, external, { ...personalAgent })
    for (const a of [suspended, adminsOnly, external, personalAgent]) db.state.agentWorkspaceGrant.push({ agentId: a.id, workspaceId: HOME, access: "READ", revokedAt: null, grantedByUserId: "admin" })
    db.state.workspaceDefaultAgent = [{ workspaceId: HOME, agentId: sharedAgent.id }]
    const forInvoker = await listRunnableAgents(prisma as never, { userId: "invoker", workspaceId: HOME })
    expect(forInvoker.agents.map((a) => a.id)).toEqual([sharedAgent.id])
    expect(forInvoker.defaultAgentId).toBe(sharedAgent.id)
    const forAdmin = await listRunnableAgents(prisma as never, { userId: "admin", workspaceId: HOME })
    expect(forAdmin.agents.map((a) => a.id).sort()).toEqual(["agent-admins", sharedAgent.id].sort())
    const forOwner = await listRunnableAgents(prisma as never, { userId: "owner", workspaceId: HOME })
    expect(forOwner.agents.map((a) => a.id)).toContain(personalAgent.id)
  })

  it("is empty, with no default, when nothing is granted", async () => {
    db.state.agentWorkspaceGrant = []
    expect(await listRunnableAgents(prisma as never, { userId: "invoker", workspaceId: HOME })).toEqual({ agents: [], defaultAgentId: null })
  })
})

it("the live-run statuses used by mcp-auth are exactly the non-terminal statuses of the run control plane", () => {
  expect([...LIVE_AGENT_RUN_STATUSES]).toEqual([...NON_TERMINAL_AGENT_RUN_STATUSES])
})

describe("invokedByForAgentActivity", () => {
  it("names the invoking user only for rows written by a run's AGENT_TURN key", async () => {
    db.state.user = [{ id: "invoker", name: " Ivy Invoker ", email: "ivy@example.com" }, { id: "owner", name: null, email: "owner@example.com" }]
    db.state.apiKey = [turnKey({ id: "turn-key" }), turnKey({ id: "personal-key", purpose: "AGENT", userId: "owner", agentId: personalAgent.id })]
    const runRow = { credentialId: "turn-key", credentialType: "API_KEY", userId: "invoker" }
    const personalRow = { credentialId: "personal-key", credentialType: "API_KEY", userId: "owner" }
    const oauthRow = { credentialId: "turn-key", credentialType: "OAUTH", userId: "invoker" }
    const names = await invokedByForAgentActivity([runRow, personalRow, oauthRow])
    expect(names.get(runRow)).toBe("Ivy Invoker")
    expect(names.has(personalRow)).toBe(false)
    expect(names.has(oauthRow)).toBe(false)
  })
})

describe("agentIdentityValidForTurn", () => {
  const turn = { agentId: sharedAgent.id, invokerUserId: "invoker", runId: "run-1" }
  it("needs a run, an agent id that matches the row, an ACTIVE CLOUD agent", () => {
    expect(agentIdentityValidForTurn(sharedAgent, turn)).toBe(true)
    expect(agentIdentityValidForTurn(sharedAgent, { ...turn, runId: undefined })).toBe(false)
    expect(agentIdentityValidForTurn(sharedAgent, { ...turn, agentId: personalAgent.id })).toBe(false)
    expect(agentIdentityValidForTurn(sharedAgent, { ...turn, agentId: null })).toBe(false)
    expect(agentIdentityValidForTurn({ ...sharedAgent, status: "SUSPENDED" }, turn)).toBe(false)
    expect(agentIdentityValidForTurn({ ...sharedAgent, kind: "EXTERNAL" }, turn)).toBe(false)
  })
  it("a USER-owned agent additionally needs the invoker to be the owner; an unknown owner type fails closed", () => {
    const personalTurn = { agentId: personalAgent.id, invokerUserId: "owner", runId: "run-1" }
    expect(agentIdentityValidForTurn(personalAgent, personalTurn)).toBe(true)
    expect(agentIdentityValidForTurn(personalAgent, { ...personalTurn, invokerUserId: "invoker" })).toBe(false)
    expect(agentIdentityValidForTurn(personalAgent, { ...personalTurn, invokerUserId: null })).toBe(false)
    expect(agentIdentityValidForTurn({ ...personalAgent, ownerType: "ORG" }, personalTurn)).toBe(false)
  })
})
