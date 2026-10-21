import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppTransactionClient } from "@/lib/db"
import {
  AGENT_LEGACY_SELECT,
  AGENT_OWNERSHIP_SELECT,
  agentEligibleInWorkspace,
  agentIdentityValidForUser,
  agentInvokePolicy,
  agentKind,
  agentOwner,
  canInvokeAgent,
  canManageAgent,
  findActiveUserOwnedAgent,
  isUserOwnedBy,
  listActiveAgentsOwnedBy,
  listAgentsForWorkspace,
  listUserOwnedAgents,
  resetAgentColumnsAvailabilityCache,
  withAgentColumns,
} from "@/lib/agent-ownership"

const HOME = "home-ws"

/** Live membership the authority checks read: who is in HOME and in which role, and their org role. */
type Person = { workspaceRole?: string; orgRole?: string }
const people: Record<string, Person | undefined> = {
  owner: { workspaceRole: "MEMBER" },
  wsAdmin: { workspaceRole: "ADMIN" },
  legacyOwnerRole: { workspaceRole: "OWNER" },
  orgAdminMember: { workspaceRole: "MEMBER", orgRole: "ADMIN" },
  member: { workspaceRole: "MEMBER" },
  outsider: undefined,
  // An org admin who is not a member of HOME is still a workspace admin there (same rule as assertWorkspaceAdmin).
  orgAdminOutsider: { orgRole: "ADMIN" },
  orgMemberOutsider: { orgRole: "MEMBER" },
}

const prisma = {
  workspace: {
    findFirst: vi.fn(async ({ where, select }: { where: { id: string }; select: { members: { where: { userId: string } } } }) => {
      const person = people[select.members.where.userId]
      if (where.id !== HOME || !person) return null
      return {
        members: person.workspaceRole ? [{ role: person.workspaceRole }] : [],
        organization: { members: person.orgRole ? [{ role: person.orgRole }] : [] },
      }
    }),
  },
  workspaceMember: {
    findFirst: vi.fn(async ({ where }: { where: { workspaceId: string; userId: string } }) =>
      where.workspaceId === HOME && people[where.userId]?.workspaceRole ? { id: "m" } : null,
    ),
  },
  agent: { findFirst: vi.fn(), findMany: vi.fn() },
  // A top-level client has $transaction; an interactive-transaction client does not (see txPrisma).
  $transaction: vi.fn(),
} as unknown as AppTransactionClient & { agent: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> } }

const userAgent = { id: "u-agent", name: "Mine", status: "ACTIVE", ownerUserId: "owner" }
const sharedAgent = { id: "w-agent", name: "Shared", status: "ACTIVE", ownerUserId: null, ownerType: "WORKSPACE", ownerWorkspaceId: HOME, kind: "CLOUD" }

beforeEach(() => resetAgentColumnsAvailabilityCache())
afterEach(() => vi.clearAllMocks())

describe("reading ownership (pure)", () => {
  it("reads NULL kind and owner_type as EXTERNAL and USER", () => {
    expect(agentKind({ kind: null })).toBe("EXTERNAL")
    expect(agentKind({})).toBe("EXTERNAL")
    expect(agentKind({ kind: "CLOUD" })).toBe("CLOUD")
    expect(agentOwner({ ownerUserId: "owner", ownerType: null, ownerWorkspaceId: null })).toEqual({ type: "USER", userId: "owner" })
    expect(agentOwner({ ownerUserId: "owner" })).toEqual({ type: "USER", userId: "owner" })
  })
  it("reads WORKSPACE ownership from owner_workspace_id", () => {
    expect(agentOwner(sharedAgent)).toEqual({ type: "WORKSPACE", workspaceId: HOME })
  })
  it("treats an inconsistent row as owned by nobody", () => {
    expect(agentOwner({ ownerUserId: null, ownerType: null, ownerWorkspaceId: null })).toBeNull()
    expect(agentOwner({ ownerUserId: "owner", ownerType: "WORKSPACE", ownerWorkspaceId: null })).toBeNull()
    expect(agentOwner({ ownerUserId: null, ownerType: "USER", ownerWorkspaceId: HOME })).toBeNull()
    expect(agentOwner({ ownerUserId: "owner", ownerType: "ORG", ownerWorkspaceId: null })).toBeNull()
  })
  it("never lets a WORKSPACE-owned row count as user-owned, even when owner_user_id is left over", () => {
    expect(isUserOwnedBy({ ...sharedAgent, ownerUserId: "owner" }, "owner")).toBe(false)
    expect(isUserOwnedBy(userAgent, "owner")).toBe(true)
    expect(isUserOwnedBy(userAgent, "other")).toBe(false)
    expect(isUserOwnedBy(userAgent, null)).toBe(false)
  })
  it("defaults the invoke policy by owner type and fails closed on unknown values", () => {
    expect(agentInvokePolicy(userAgent)).toBe("OWNER")
    expect(agentInvokePolicy(sharedAgent)).toBe("WORKSPACE_MEMBERS")
    expect(agentInvokePolicy({ ...sharedAgent, invokePolicy: "ADMINS" })).toBe("ADMINS")
    expect(agentInvokePolicy({ ...sharedAgent, invokePolicy: "EVERYONE" })).toBe("OWNER")
  })
})

describe("agentIdentityValidForUser (an already authenticated agentId)", () => {
  it.each([
    ["USER-owned, the owner", userAgent, "owner", true],
    ["USER-owned, someone else", userAgent, "other", false],
    ["USER-owned, no user", userAgent, null, false],
    // A user id says nothing about a shared agent: only an agent-scoped credential (PR2) can reach it.
    ["WORKSPACE-owned, any user", sharedAgent, "anyone", false],
    ["WORKSPACE-owned, a workspace admin", sharedAgent, "wsAdmin", false],
    ["WORKSPACE-owned, the leftover owner_user_id holder", { ...sharedAgent, ownerUserId: "owner" }, "owner", false],
    ["WORKSPACE-owned, no user", sharedAgent, null, false],
    ["WORKSPACE-owned, undefined user", sharedAgent, undefined, false],
    ["suspended USER-owned", { ...userAgent, status: "SUSPENDED" }, "owner", false],
    ["suspended WORKSPACE-owned", { ...sharedAgent, status: "SUSPENDED" }, "anyone", false],
    ["inconsistent row", { ...userAgent, ownerUserId: null }, "owner", false],
  ])("%s", (_label, agent, userId, expected) => {
    expect(agentIdentityValidForUser(agent, userId)).toBe(expected)
  })
})

describe("assignment eligibility: owner type x grant x owner membership", () => {
  const members = new Set(["owner"])
  it.each([
    ["USER-owned, grant, owner is a member", userAgent, true, members, true],
    ["USER-owned, grant, owner left", userAgent, true, new Set<string>(), false],
    ["USER-owned, no grant, owner is a member", userAgent, false, members, false],
    ["WORKSPACE-owned, grant, nobody is a member", sharedAgent, true, new Set<string>(), true],
    ["WORKSPACE-owned, no grant", sharedAgent, false, members, false],
    ["WORKSPACE-owned, grant, suspended", { ...sharedAgent, status: "SUSPENDED" }, true, members, false],
    ["USER-owned, grant, suspended", { ...userAgent, status: "SUSPENDED" }, true, members, false],
    ["inconsistent row, grant", { ...sharedAgent, ownerWorkspaceId: null }, true, members, false],
    ["WORKSPACE-owned by another workspace, grant here", { ...sharedAgent, ownerWorkspaceId: "other-ws" }, true, members, false],
  ])("%s", (_label, agent, hasLiveGrant, memberUserIds, expected) => {
    expect(agentEligibleInWorkspace(agent, { workspaceId: HOME, hasLiveGrant, memberUserIds })).toBe(expected)
  })
})

describe("canManageAgent", () => {
  it.each([
    ["USER-owned: the owner", userAgent, "owner", true],
    ["USER-owned: a workspace admin", userAgent, "wsAdmin", false],
    ["USER-owned: another member", userAgent, "member", false],
    ["USER-owned: a non-member", userAgent, "outsider", false],
    ["WORKSPACE-owned: a workspace admin", sharedAgent, "wsAdmin", true],
    ["WORKSPACE-owned: a legacy OWNER-role member", sharedAgent, "legacyOwnerRole", true],
    ["WORKSPACE-owned: an org admin who is a member", sharedAgent, "orgAdminMember", true],
    ["WORKSPACE-owned: a plain member", sharedAgent, "member", false],
    ["WORKSPACE-owned: a non-member", sharedAgent, "outsider", false],
    ["WORKSPACE-owned: an org admin who is not a member (as assertWorkspaceAdmin)", sharedAgent, "orgAdminOutsider", true],
    ["WORKSPACE-owned: a plain org member who is not a workspace member", sharedAgent, "orgMemberOutsider", false],
    ["WORKSPACE-owned: the leftover owner_user_id holder, now a plain member", { ...sharedAgent, ownerUserId: "owner" }, "owner", false],
  ])("%s", async (_label, agent, userId, expected) => {
    expect(await canManageAgent(prisma, { userId }, agent)).toBe(expected)
  })
  it("refuses an anonymous actor and an inconsistent row", async () => {
    expect(await canManageAgent(prisma, { userId: null }, userAgent)).toBe(false)
    expect(await canManageAgent(prisma, { userId: "owner" }, { ownerUserId: null })).toBe(false)
  })
})

describe("canInvokeAgent", () => {
  const policies = (policy: string | null) => ({ ...sharedAgent, invokePolicy: policy })
  it.each([
    // USER-owned: only the owner, whatever the stored policy says.
    ["USER-owned: the owner", userAgent, "owner", true],
    ["USER-owned with WORKSPACE_MEMBERS: a member still cannot", { ...userAgent, invokePolicy: "WORKSPACE_MEMBERS" }, "member", false],
    ["USER-owned: a workspace admin", userAgent, "wsAdmin", false],
    ["USER-owned: a non-member", userAgent, "outsider", false],
    // WORKSPACE-owned, default policy (WORKSPACE_MEMBERS).
    ["WORKSPACE-owned default policy: a member", policies(null), "member", true],
    ["WORKSPACE-owned default policy: an admin", policies(null), "wsAdmin", true],
    ["WORKSPACE-owned default policy: a non-member", policies(null), "outsider", false],
    // ADMINS and OWNER mean the people who manage it.
    ["WORKSPACE-owned ADMINS: an admin", policies("ADMINS"), "wsAdmin", true],
    ["WORKSPACE-owned ADMINS: a member", policies("ADMINS"), "member", false],
    ["WORKSPACE-owned ADMINS: a non-member", policies("ADMINS"), "outsider", false],
    ["WORKSPACE-owned OWNER: an admin", policies("OWNER"), "wsAdmin", true],
    ["WORKSPACE-owned OWNER: a member", policies("OWNER"), "member", false],
    // An unknown stored policy fails closed to the admin-only reading.
    ["WORKSPACE-owned unknown policy: a member", policies("EVERYONE"), "member", false],
    ["WORKSPACE-owned unknown policy: an admin", policies("EVERYONE"), "wsAdmin", true],
    // Suspension beats every policy.
    ["suspended USER-owned: the owner", { ...userAgent, status: "SUSPENDED" }, "owner", false],
    ["suspended WORKSPACE-owned: an admin", { ...policies(null), status: "SUSPENDED" }, "wsAdmin", false],
  ])("%s", async (_label, agent, userId, expected) => {
    expect(await canInvokeAgent(prisma, { userId }, agent)).toBe(expected)
  })
  it("refuses an anonymous actor", async () => {
    expect(await canInvokeAgent(prisma, { userId: undefined }, sharedAgent)).toBe(false)
    expect(await canInvokeAgent(prisma, { userId: null }, sharedAgent)).toBe(false)
    expect(await canInvokeAgent(prisma, { userId: null }, userAgent)).toBe(false)
  })
  it("refuses a suspended agent without consulting membership", async () => {
    expect(await canInvokeAgent(prisma, { userId: "member" }, { ...sharedAgent, status: "SUSPENDED" })).toBe(false)
    expect(prisma.workspaceMember.findFirst).not.toHaveBeenCalled()
  })
  it("refuses a malformed WORKSPACE row without ownerWorkspaceId", async () => {
    const malformed = { ...sharedAgent, ownerWorkspaceId: null }
    expect(await canInvokeAgent(prisma, { userId: "wsAdmin" }, malformed)).toBe(false)
    expect(await canInvokeAgent(prisma, { userId: "member" }, { ...malformed, invokePolicy: "WORKSPACE_MEMBERS" })).toBe(false)
  })
  it("refuses a non-member under WORKSPACE_MEMBERS, even one with org-admin rights elsewhere", async () => {
    const open = { ...sharedAgent, invokePolicy: "WORKSPACE_MEMBERS" }
    expect(await canInvokeAgent(prisma, { userId: "outsider" }, open)).toBe(false)
    expect(await canInvokeAgent(prisma, { userId: "orgMemberOutsider" }, open)).toBe(false)
  })
})

describe("loading, and tolerating an unapplied migration 098", () => {
  const missingColumn = Object.assign(new Error("column agents.kind does not exist"), { code: "P2022" })

  it("selects the ownership columns when they exist", async () => {
    prisma.agent.findFirst.mockResolvedValueOnce(sharedAgent)
    expect(await findActiveUserOwnedAgent(prisma, "w-agent", "owner")).toBeNull()
    expect(prisma.agent.findFirst).toHaveBeenCalledWith({ where: { id: "w-agent" }, select: AGENT_OWNERSHIP_SELECT })
  })
  it("retries with the legacy columns when a column is missing, and stays on them", async () => {
    prisma.agent.findFirst.mockRejectedValueOnce(missingColumn).mockResolvedValue(userAgent)
    expect(await findActiveUserOwnedAgent(prisma, "u-agent", "owner")).toMatchObject({ id: "u-agent" })
    expect(prisma.agent.findFirst).toHaveBeenNthCalledWith(2, { where: { id: "u-agent" }, select: AGENT_LEGACY_SELECT })
    // The negative result is cached, so the next read goes straight to the legacy columns.
    prisma.agent.findFirst.mockClear()
    await findActiveUserOwnedAgent(prisma, "u-agent", "owner")
    expect(prisma.agent.findFirst).toHaveBeenCalledTimes(1)
    expect(prisma.agent.findFirst).toHaveBeenCalledWith({ where: { id: "u-agent" }, select: AGENT_LEGACY_SELECT })
  })
  it("also recognizes a driver-level 'column does not exist' message without a code", async () => {
    prisma.agent.findFirst.mockRejectedValueOnce(new Error('column "owner_workspace_id" does not exist')).mockResolvedValue(userAgent)
    expect(await findActiveUserOwnedAgent(prisma, "u-agent", "owner")).toMatchObject({ id: "u-agent" })
  })
  it("rethrows every other error", async () => {
    prisma.agent.findFirst.mockRejectedValueOnce(new Error("connection reset"))
    await expect(findActiveUserOwnedAgent(prisma, "u-agent", "owner")).rejects.toThrow("connection reset")
  })
  describe("inside a transaction (a failed statement aborts it, so no error-driven retry)", () => {
    /** Behaves like PostgreSQL: after any error every later statement fails until rollback. */
    function abortingTx() {
      let aborted = false
      const guard = (fn: (args: unknown) => unknown) => vi.fn(async (args: { select: unknown }) => {
        if (aborted) throw new Error("current transaction is aborted, commands ignored until end of transaction block")
        if (args.select === AGENT_OWNERSHIP_SELECT) { aborted = true; throw missingColumn }
        return fn(args)
      })
      return {
        agent: { findFirst: guard(() => userAgent), findMany: guard(() => [userAgent]) },
        agentWorkspaceGrant: { updateMany: vi.fn(async () => ({ count: 1 })) },
      } as unknown as AppTransactionClient & { agent: { findMany: ReturnType<typeof vi.fn> } }
    }
    it("reads the legacy columns when the availability is unknown, never touching the new ones", async () => {
      const tx = abortingTx()
      expect((await listUserOwnedAgents(tx, "owner")).map((a) => a.id)).toEqual(["u-agent"])
      expect(tx.agent.findMany).toHaveBeenCalledTimes(1)
      expect(tx.agent.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: AGENT_LEGACY_SELECT }))
    })
    it("revokeMemberAgentGrants completes inside a transaction on a database without 098", async () => {
      const { revokeMemberAgentGrants } = await import("@/lib/agent-lifecycle")
      const tx = abortingTx()
      await revokeMemberAgentGrants(tx, HOME, "owner")
      expect(tx.agentWorkspaceGrant.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ agentId: { in: ["u-agent"] } }) }))
    })
    it("uses the new columns once a top-level call has proven they exist", async () => {
      prisma.agent.findMany.mockResolvedValueOnce([])
      await listUserOwnedAgents(prisma, "owner")
      const tx = { agent: { findMany: vi.fn(async () => []) } } as unknown as AppTransactionClient & { agent: { findMany: ReturnType<typeof vi.fn> } }
      await listUserOwnedAgents(tx, "owner")
      expect(tx.agent.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: AGENT_OWNERSHIP_SELECT }))
    })
    it("a transaction never records a negative availability for later top-level calls", async () => {
      await listUserOwnedAgents(abortingTx(), "owner")
      prisma.agent.findMany.mockResolvedValueOnce([])
      await listUserOwnedAgents(prisma, "owner")
      expect(prisma.agent.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: AGENT_OWNERSHIP_SELECT }))
    })
  })
  it("tells the callback whether the new columns may be used in a where", async () => {
    const seen: boolean[] = []
    await withAgentColumns(prisma, async ({ extended }) => { seen.push(extended); if (extended) throw missingColumn; return null })
    expect(seen).toEqual([true, false])
  })
  it("does not filter on owner_workspace_id while the migration is unapplied", async () => {
    prisma.agent.findMany.mockRejectedValueOnce(missingColumn).mockResolvedValueOnce([userAgent])
    const rows = await listActiveAgentsOwnedBy(prisma, { userIds: ["owner"], workspaceIds: [HOME] })
    expect(rows.map((a) => a.id)).toEqual(["u-agent"])
    expect(prisma.agent.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { status: "ACTIVE", OR: [{ ownerUserId: { in: ["owner"] } }] } }))
  })
})

describe("listings", () => {
  it("listUserOwnedAgents drops a WORKSPACE-owned row that still carries the user's id", async () => {
    prisma.agent.findMany.mockResolvedValueOnce([userAgent, { ...sharedAgent, ownerUserId: "owner" }])
    expect((await listUserOwnedAgents(prisma, "owner")).map((a) => a.id)).toEqual(["u-agent"])
  })
  it("listActiveAgentsOwnedBy keeps only owners that were asked for", async () => {
    prisma.agent.findMany.mockResolvedValueOnce([userAgent, { ...userAgent, id: "stranger", ownerUserId: "stranger" }, sharedAgent, { ...sharedAgent, id: "foreign", ownerWorkspaceId: "other-ws" }])
    const rows = await listActiveAgentsOwnedBy(prisma, { userIds: ["owner"], workspaceIds: [HOME] })
    expect(rows.map((a) => a.id)).toEqual(["u-agent", "w-agent"])
  })
  it("listAgentsForWorkspace: a manager sees member-owned, workspace-owned and granted agents; others only granted ones", async () => {
    const granted = { ...userAgent, id: "granted", ownerUserId: "former-member" }
    prisma.agent.findMany.mockResolvedValue([userAgent, granted, sharedAgent, { ...userAgent, id: "stranger", ownerUserId: "stranger" }, { ...sharedAgent, id: "foreign", ownerWorkspaceId: "other-ws" }])
    const asManager = await listAgentsForWorkspace(prisma, HOME, { memberUserIds: ["owner"], grantedAgentIds: ["granted"], includeGrantable: true })
    expect(asManager.map((a) => a.id)).toEqual(["u-agent", "granted", "w-agent"])
    expect(prisma.agent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { OR: [{ id: { in: ["granted"] } }, { ownerUserId: { in: ["owner"] } }, { ownerWorkspaceId: HOME }] },
    }))
    const asMember = await listAgentsForWorkspace(prisma, HOME, { memberUserIds: ["owner"], grantedAgentIds: ["granted"], includeGrantable: false })
    expect(asMember.map((a) => a.id)).toEqual(["granted"])
  })
})
