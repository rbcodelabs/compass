/**
 * The consent screen's binding computation (ADR 0015, stage 2).
 *
 * Three things here are not ordinary unit tests, and they are the reason this
 * file exists rather than a couple of cases bolted onto oauth-consent.test.ts.
 *
 * **The zero-grantable-workspaces case.** For a plain member of someone else's
 * organization the grantable set is empty, and their inline-created agent would
 * reach nothing. Rick's own account — sole owner of its only org — cannot
 * reproduce that state, so it is invisible in manual testing and defining for
 * everyone else. It gets explicit coverage at every layer: the set itself, the
 * resolver's refusal, and the remembered-binding re-validation.
 *
 * **The admin-override predicate.** It is an escalation gate, so the interesting
 * assertions are the *denials*: a single non-admin membership must sink it, and
 * a user who belongs to no organization at all must not acquire it by the
 * vacuous truth of `[].every(...)`.
 *
 * **Effective reach is an intersection, not a lookup.** `agentWorkspaceWhere`
 * ANDs the grant set with the owner's current membership
 * (lib/agent-access.ts:13-17), so a grant in a workspace the owner has left
 * confers nothing. A screen that listed it would overstate the grant on the one
 * screen whose entire job is to state it accurately.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createOAuthStore } from "../helpers/oauth-store"

const store = createOAuthStore()
vi.mock("@/lib/db", () => ({ default: () => store.prisma }))

import {
  inlineGrantAccess,
  loadConsentBindingOptions,
  overridePredicateHolds,
  resolveConsentBinding,
  revalidateRememberedBinding,
  selectAgentReach,
  selectGrantableWorkspaces,
  type BindingEffects,
  type ConsentBindingOptions,
  type WorkspaceMembershipRow,
} from "@/lib/oauth/agent-binding"

function membership(
  overrides: {
    workspaceId?: string
    workspaceName?: string
    workspaceSlug?: string
    role?: string | null
    orgId?: string
    orgName?: string
    orgSlug?: string
    orgRole?: string | null
    /** Simulates a membership row whose workspace has been deleted. */
    dangling?: boolean
  } = {},
): WorkspaceMembershipRow {
  if (overrides.dangling) return { role: overrides.role ?? "MEMBER", workspace: null }
  return {
    role: overrides.role ?? "MEMBER",
    workspace: {
      id: overrides.workspaceId ?? "ws-1",
      name: overrides.workspaceName ?? "Compass",
      slug: overrides.workspaceSlug ?? "compass",
      organization: {
        id: overrides.orgId ?? "org-1",
        name: overrides.orgName ?? "rbcodelabs",
        slug: overrides.orgSlug ?? "rbcodelabs",
        members: overrides.orgRole === undefined ? [] : [{ role: overrides.orgRole }],
      },
    },
  }
}

describe("the grantable set — member AND admin, never merely member", () => {
  it("includes a workspace the user administers", () => {
    const { grantable } = selectGrantableWorkspaces([membership({ role: "ADMIN" })])
    expect(grantable.map((workspace) => workspace.id)).toEqual(["ws-1"])
  })

  it("includes every workspace in an organization the user owns or administers", () => {
    for (const orgRole of ["OWNER", "ADMIN", "owner", " admin "]) {
      const { grantable } = selectGrantableWorkspaces([membership({ role: "MEMBER", orgRole })])
      expect(grantable, `org role ${JSON.stringify(orgRole)} should grant`).toHaveLength(1)
    }
  })

  it("counts a legacy workspace role of OWNER as administrator", () => {
    // The column is a bare VarChar and create_workspace wrote "OWNER" into it.
    // An exact match against "ADMIN" would exclude the workspace's own creator.
    const { grantable } = selectGrantableWorkspaces([membership({ role: "owner" })])
    expect(grantable).toHaveLength(1)
  })

  /**
   * The case Rick's account cannot produce and everyone else lives in. It is
   * asserted as *empty*, deliberately — the remedy is that an administrator
   * grants an agent access, not that consent quietly widens who may grant.
   */
  it("is EMPTY for a plain member of someone else's organization", () => {
    const { grantable } = selectGrantableWorkspaces([
      membership({ workspaceId: "ws-1", role: "MEMBER", orgRole: "MEMBER" }),
      membership({ workspaceId: "ws-2", role: "MEMBER", orgRole: null }),
      membership({ workspaceId: "ws-3", role: "member" }),
    ])
    expect(grantable).toEqual([])
  })

  it("counts a membership pointing at a deleted workspace rather than throwing", () => {
    const { grantable, unresolved } = selectGrantableWorkspaces([
      membership({ role: "ADMIN" }),
      membership({ dangling: true, role: "ADMIN" }),
    ])
    expect(grantable).toHaveLength(1)
    expect(unresolved).toBe(1)
  })

  it("does not list the same workspace twice when a duplicate membership row exists", () => {
    const { grantable } = selectGrantableWorkspaces([
      membership({ role: "ADMIN" }),
      membership({ role: "ADMIN" }),
    ])
    expect(grantable).toHaveLength(1)
  })

  it("sorts by organization then workspace so the list is stable across renders", () => {
    const { grantable } = selectGrantableWorkspaces([
      membership({ workspaceId: "b", workspaceName: "Zebra", orgName: "Acme", role: "ADMIN" }),
      membership({ workspaceId: "a", workspaceName: "Apple", orgName: "Acme", role: "ADMIN" }),
      membership({ workspaceId: "c", workspaceName: "Alpha", orgName: "Zenith", role: "ADMIN" }),
    ])
    expect(grantable.map((workspace) => workspace.id)).toEqual(["a", "b", "c"])
  })
})

describe("the admin-override predicate", () => {
  it("holds when the user owns or administers every organization they belong to", () => {
    expect(overridePredicateHolds(["OWNER"])).toBe(true)
    expect(overridePredicateHolds(["OWNER", "ADMIN", "admin"])).toBe(true)
  })

  it("fails on a single organization where the user is a plain member", () => {
    // Being an admin of org A does not justify unrestricted reach into org B,
    // and a user-mode token carries reach into both.
    expect(overridePredicateHolds(["OWNER", "MEMBER"])).toBe(false)
    expect(overridePredicateHolds(["ADMIN", null])).toBe(false)
  })

  it("does not hold vacuously for a user who belongs to no organization", () => {
    // `[].every(...)` is true. The rule is "you already personally hold this
    // authority", and holding it nowhere is not holding it everywhere.
    expect(overridePredicateHolds([])).toBe(false)
  })
})

describe("effective reach — grants intersected with current membership", () => {
  const members = new Map([
    ["ws-1", { name: "Compass", organizationName: "rbcodelabs" }],
    ["ws-2", { name: "Geode", organizationName: "rbcodelabs" }],
  ])

  it("drops a grant in a workspace the owner has left", () => {
    const reach = selectAgentReach(
      [
        { agentId: "a1", workspaceId: "ws-1", access: "WRITE" },
        { agentId: "a1", workspaceId: "ws-gone", access: "WRITE" },
      ],
      members,
    )
    expect(reach.get("a1")?.map((entry) => entry.workspaceId)).toEqual(["ws-1"])
  })

  it("treats anything that is not exactly WRITE as read access", () => {
    // `agentWorkspaceWhere` filters on `access: "WRITE"` exactly, so a stray
    // lowercase value in the bare VarChar buys no write access at the gate. The
    // screen must say the same thing the gate will do, not something kinder.
    const reach = selectAgentReach(
      [
        { agentId: "a1", workspaceId: "ws-1", access: "WRITE" },
        { agentId: "a1", workspaceId: "ws-2", access: "write" },
      ],
      members,
    )
    // Sorted Compass, then Geode.
    expect(reach.get("a1")?.map((entry) => [entry.workspaceName, entry.access])).toEqual([
      ["Compass", "WRITE"],
      ["Geode", "READ"],
    ])
  })

  it("returns nothing for an agent with no grants at all", () => {
    expect(selectAgentReach([], members).get("a1")).toBeUndefined()
  })
})

describe("the access level an inline-created agent is granted", () => {
  it("matches the verb the client asked for", () => {
    expect(inlineGrantAccess(["mcp:read", "mcp:write"])).toBe("WRITE")
    expect(inlineGrantAccess(["mcp:read", "offline_access"])).toBe("READ")
    expect(inlineGrantAccess([])).toBe("READ")
  })
})

// ── loading, against the in-memory store ──────────────────────────────────

async function seedMembership(overrides: Parameters<typeof membership>[0] = {}) {
  const row = membership(overrides)
  await store.workspaceMember.create({ data: { userId: "user-1", ...row } })
  if (row.workspace)
    await store.workspace.create({
      data: { id: row.workspace.id, members: [{ userId: "user-1" }] },
    })
}

beforeEach(() => {
  store.reset()
  vi.unstubAllEnvs()
})

describe("loadConsentBindingOptions", () => {
  it("renders no agent options when COMPASS_AGENTS_ENABLED is off", async () => {
    vi.stubEnv("COMPASS_AGENTS_ENABLED", "")
    await seedMembership({ role: "ADMIN" })
    await store.agent.create({ data: { ownerUserId: "user-1", name: "Existing" } })

    const options = await loadConsentBindingOptions("user-1")
    // The flag's off-state is Phase 1 behavior verbatim, which is the whole
    // reason it is usable as a rollout control.
    expect(options.agentsEnabled).toBe(false)
    expect(options.agents).toEqual([])
    expect(options.grantable).toHaveLength(1)
  })

  it("lists live agents with the reach they actually hold", async () => {
    vi.stubEnv("COMPASS_AGENTS_ENABLED", "1")
    await seedMembership({ workspaceId: "ws-1", workspaceName: "Compass", role: "ADMIN" })
    const granted = await store.agent.create({
      data: { ownerUserId: "user-1", name: "Granted" },
      select: { id: true },
    })
    await store.agent.create({ data: { ownerUserId: "user-1", name: "Ungranted" } })
    await store.agentWorkspaceGrant.create({
      data: { agentId: granted.id, workspaceId: "ws-1", access: "WRITE" },
    })

    const options = await loadConsentBindingOptions("user-1")
    const byName = new Map(options.agents.map((agent) => [agent.name, agent]))
    expect(byName.get("Granted")?.reach).toEqual([
      { workspaceId: "ws-1", workspaceName: "Compass", organizationName: "rbcodelabs", access: "WRITE" },
    ])
    // Present in the list, but with no reach — so the screen can show it and
    // refuse it, rather than hiding it and leaving the user wondering.
    expect(byName.get("Ungranted")?.reach).toEqual([])
  })

  it("excludes a suspended agent entirely", async () => {
    vi.stubEnv("COMPASS_AGENTS_ENABLED", "1")
    await seedMembership({ role: "ADMIN" })
    await store.agent.create({
      data: { ownerUserId: "user-1", name: "Suspended", status: "SUSPENDED" },
    })
    expect((await loadConsentBindingOptions("user-1")).agents).toEqual([])
  })

  it("withholds the override when a workspace membership has no matching organization membership", async () => {
    vi.stubEnv("COMPASS_AGENTS_ENABLED", "1")
    await store.organizationMember.create({
      data: { organizationId: "org-1", userId: "user-1", role: "OWNER" },
    })
    await seedMembership({
      workspaceId: "ws-2",
      workspaceName: "Other workspace",
      orgId: "org-2",
      orgName: "Other organization",
      role: "MEMBER",
    })

    expect((await loadConsentBindingOptions("user-1")).overrideAvailable).toBe(false)
  })
})

// ── resolving a submitted binding ─────────────────────────────────────────

function options(overrides: Partial<ConsentBindingOptions> = {}): ConsentBindingOptions {
  return {
    agentsEnabled: true,
    agents: [
      {
        id: "agent-live",
        name: "Compass PM Agent",
        reach: [
          {
            workspaceId: "ws-1",
            workspaceName: "Compass",
            organizationName: "rbcodelabs",
            access: "WRITE",
          },
        ],
      },
      { id: "agent-dead", name: "Ungranted Agent", reach: [] },
    ],
    grantable: [
      {
        id: "ws-1",
        name: "Compass",
        slug: "compass",
        organizationId: "org-1",
        organizationName: "rbcodelabs",
        organizationSlug: "rbcodelabs",
      },
    ],
    overrideAvailable: true,
    unresolvedMemberships: 0,
    ...overrides,
  }
}

function effects(): BindingEffects & {
  created: string[]
  granted: Array<[string, string, string, string]>
  deleted: string[]
} {
  const created: string[] = []
  const granted: Array<[string, string, string, string]> = []
  const deleted: string[] = []
  return {
    created,
    granted,
    deleted,
    async createAgent(name) {
      created.push(name)
      return { id: "agent-new" }
    },
    async grantWorkspace(orgSlug, workspaceSlug, agentId, access) {
      granted.push([orgSlug, workspaceSlug, agentId, access])
    },
    async deleteAgent(agentId) {
      deleted.push(agentId)
    },
  }
}

const context = (overrides: Partial<Parameters<typeof resolveConsentBinding>[1]> = {}) => ({
  userId: "user-1",
  userEmail: "rick@rbcodelabs.com",
  requestedScopes: ["mcp:read", "mcp:write"],
  options: options(),
  ...overrides,
})

describe("resolveConsentBinding — every unsigned field is re-validated", () => {
  it("binds to an existing agent the caller owns", async () => {
    const result = await resolveConsentBinding(
      { binding: "agent", agentId: "agent-live", agentName: null, grantWorkspaceIds: [], confirmation: null },
      context(),
      effects(),
    )
    expect(result).toEqual({
      ok: true,
      binding: { authorizationMode: "AGENT", agentId: "agent-live" },
      createdAgentId: null,
    })
  })

  it("refuses an agent id the caller does not own", async () => {
    // Answered as "not available" rather than "not yours": the difference is
    // only interesting to someone probing for other people's agent ids.
    const result = await resolveConsentBinding(
      { binding: "agent", agentId: "someone-elses", agentName: null, grantWorkspaceIds: [], confirmation: null },
      context(),
      effects(),
    )
    expect(result).toMatchObject({ ok: false })
  })

  it("refuses an existing agent with no reach, naming the remedy", async () => {
    const result = await resolveConsentBinding(
      { binding: "agent", agentId: "agent-dead", agentName: null, grantWorkspaceIds: [], confirmation: null },
      context(),
      effects(),
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toMatch(/workspace administrator/i)
  })

  it("creates an agent and grants it the ticked workspaces through the Settings path", async () => {
    const side = effects()
    const result = await resolveConsentBinding(
      { binding: "new", agentId: null, agentName: " Geode PM ", grantWorkspaceIds: ["ws-1"], confirmation: null },
      context(),
      side,
    )
    expect(result).toEqual({
      ok: true,
      binding: { authorizationMode: "AGENT", agentId: "agent-new" },
      createdAgentId: "agent-new",
    })
    expect(side.created).toEqual(["Geode PM"])
    expect(side.granted).toEqual([["rbcodelabs", "compass", "agent-new", "WRITE"]])
  })

  it("grants read only when the client asked only to read", async () => {
    const side = effects()
    await resolveConsentBinding(
      { binding: "new", agentId: null, agentName: "Reader", grantWorkspaceIds: ["ws-1"], confirmation: null },
      context({ requestedScopes: ["mcp:read"] }),
      side,
    )
    expect(side.granted[0][3]).toBe("READ")
  })

  it("refuses a workspace the caller is not an administrator of, before creating anything", async () => {
    const side = effects()
    const result = await resolveConsentBinding(
      { binding: "new", agentId: null, agentName: "Sneaky", grantWorkspaceIds: ["ws-not-mine"], confirmation: null },
      context(),
      side,
    )
    expect(result).toMatchObject({ ok: false })
    expect(side.created, "nothing may be created before the grants validate").toEqual([])
  })

  it("refuses to create an agent with no workspaces — that is the dead credential", async () => {
    const result = await resolveConsentBinding(
      { binding: "new", agentId: null, agentName: "Empty", grantWorkspaceIds: [], confirmation: null },
      context(),
      effects(),
    )
    expect(result).toMatchObject({ ok: false })
  })

  it("refuses inline creation outright when nothing is grantable", async () => {
    const result = await resolveConsentBinding(
      { binding: "new", agentId: null, agentName: "Hopeful", grantWorkspaceIds: ["ws-1"], confirmation: null },
      context({ options: options({ grantable: [] }) }),
      effects(),
    )
    expect(result).toMatchObject({ ok: false })
  })

  it("rolls the new agent back when a grant fails mid-way", async () => {
    // A partially-granted agent is exactly the under-reaching credential this
    // module refuses to mint, and it would be invisible until it failed.
    const side = effects()
    side.grantWorkspace = async () => {
      throw new Error("Membership changed; retry the operation")
    }
    const result = await resolveConsentBinding(
      { binding: "new", agentId: null, agentName: "Doomed", grantWorkspaceIds: ["ws-1"], confirmation: null },
      context(),
      side,
    )
    expect(result).toMatchObject({ ok: false })
    expect(side.deleted).toEqual(["agent-new"])
  })

  it("rejects a blank or over-long agent name", async () => {
    for (const agentName of ["", "   ", "x".repeat(121)]) {
      const result = await resolveConsentBinding(
        { binding: "new", agentId: null, agentName, grantWorkspaceIds: ["ws-1"], confirmation: null },
        context(),
        effects(),
      )
      expect(result).toMatchObject({ ok: false })
    }
  })

  it("allows the override with a matching typed confirmation", async () => {
    const result = await resolveConsentBinding(
      { binding: "user", agentId: null, agentName: null, grantWorkspaceIds: [], confirmation: "  RICK@rbcodelabs.com " },
      context(),
      effects(),
    )
    expect(result).toEqual({
      ok: true,
      binding: { authorizationMode: "USER", agentId: null },
      createdAgentId: null,
    })
  })

  it("refuses the override when the confirmation does not match", async () => {
    for (const confirmation of [null, "", "rick@example.com"]) {
      const result = await resolveConsentBinding(
        { binding: "user", agentId: null, agentName: null, grantWorkspaceIds: [], confirmation },
        context(),
        effects(),
      )
      expect(result).toMatchObject({ ok: false })
    }
  })

  it("refuses the override when the predicate does not hold, even with a perfect confirmation", async () => {
    const result = await resolveConsentBinding(
      { binding: "user", agentId: null, agentName: null, grantWorkspaceIds: [], confirmation: "rick@rbcodelabs.com" },
      context({ options: options({ overrideAvailable: false }) }),
      effects(),
    )
    expect(result).toMatchObject({ ok: false })
  })

  it("never reads a missing or unrecognised binding as a choice", async () => {
    for (const binding of [null, "", "AGENT", "service", "admin"]) {
      const result = await resolveConsentBinding(
        { binding, agentId: "agent-live", agentName: null, grantWorkspaceIds: [], confirmation: null },
        context(),
        effects(),
      )
      expect(result, `binding ${JSON.stringify(binding)} must not resolve`).toMatchObject({
        ok: false,
      })
    }
  })

  it("falls back to Phase 1 user mode when agents are switched off", async () => {
    const result = await resolveConsentBinding(
      { binding: "agent", agentId: "agent-live", agentName: null, grantWorkspaceIds: [], confirmation: null },
      context({ options: options({ agentsEnabled: false }) }),
      effects(),
    )
    expect(result).toEqual({
      ok: true,
      binding: { authorizationMode: "USER", agentId: null },
      createdAgentId: null,
    })
  })
})

describe("revalidateRememberedBinding — a reconnect re-checks the world", () => {
  beforeEach(() => vi.stubEnv("COMPASS_AGENTS_ENABLED", "1"))

  async function seedHealthyAgent() {
    await store.workspace.create({ data: { id: "ws-1", members: [{ userId: "user-1" }] } })
    await store.agent.create({ data: { id: "agent-1", ownerUserId: "user-1", name: "A" } })
    await store.agentWorkspaceGrant.create({
      data: { agentId: "agent-1", workspaceId: "ws-1", access: "READ" },
    })
  }

  it("replays a healthy agent binding", async () => {
    await seedHealthyAgent()
    expect(
      await revalidateRememberedBinding({ authorizationMode: "AGENT", agentId: "agent-1" }, "user-1"),
    ).toEqual({ authorizationMode: "AGENT", agentId: "agent-1" })
  })

  it("refuses to replay when the agent has been suspended", async () => {
    await seedHealthyAgent()
    await store.agent.updateMany({ where: { id: "agent-1" }, data: { status: "SUSPENDED" } })
    expect(
      await revalidateRememberedBinding({ authorizationMode: "AGENT", agentId: "agent-1" }, "user-1"),
    ).toBeNull()
  })

  it("refuses to replay when every grant has been revoked", async () => {
    await seedHealthyAgent()
    await store.agentWorkspaceGrant.updateMany({
      where: { agentId: "agent-1" },
      data: { revokedAt: new Date() },
    })
    // Otherwise the reconnect re-mints the dead credential: authenticates,
    // then fails every call with "Workspace not found or access denied."
    expect(
      await revalidateRememberedBinding({ authorizationMode: "AGENT", agentId: "agent-1" }, "user-1"),
    ).toBeNull()
  })

  it("refuses to replay when the owner has left the only granted workspace", async () => {
    await seedHealthyAgent()
    await store.workspace.updateMany({ where: { id: "ws-1" }, data: { members: [] } })
    expect(
      await revalidateRememberedBinding({ authorizationMode: "AGENT", agentId: "agent-1" }, "user-1"),
    ).toBeNull()
  })

  it("refuses to replay an agent binding while agents are switched off", async () => {
    await seedHealthyAgent()
    vi.stubEnv("COMPASS_AGENTS_ENABLED", "")
    // Never downgraded to USER: that would make flipping the flag off an
    // upgrade from a grant-scoped token to an account-wide one.
    expect(
      await revalidateRememberedBinding({ authorizationMode: "AGENT", agentId: "agent-1" }, "user-1"),
    ).toBeNull()
  })

  it("re-evaluates the override predicate rather than trusting the stored row", async () => {
    await store.organizationMember.create({
      data: { organizationId: "org-1", userId: "user-1", role: "OWNER" },
    })
    expect(
      await revalidateRememberedBinding({ authorizationMode: "USER", agentId: null }, "user-1"),
    ).toEqual({ authorizationMode: "USER", agentId: null })

    await store.organizationMember.create({
      data: { organizationId: "org-2", userId: "user-1", role: "MEMBER" },
    })
    // Joining a second organization as a plain member costs the override at the
    // next authorization, not thirty days later.
    expect(
      await revalidateRememberedBinding({ authorizationMode: "USER", agentId: null }, "user-1"),
    ).toBeNull()
  })

  it("refuses a legacy null mode rather than widening it to USER", async () => {
    await store.organizationMember.create({
      data: { organizationId: "org-1", userId: "user-1", role: "ADMIN" },
    })
    expect(
      await revalidateRememberedBinding({ authorizationMode: null, agentId: null }, "user-1"),
    ).toBeNull()
  })

  it("refuses an unrecognized remembered mode rather than widening it to USER", async () => {
    await store.organizationMember.create({
      data: { organizationId: "org-1", userId: "user-1", role: "ADMIN" },
    })
    expect(
      await revalidateRememberedBinding({ authorizationMode: "RESEARCH", agentId: null }, "user-1"),
    ).toBeNull()
  })

  it("refuses to replay the override when a workspace membership has no organization-member row", async () => {
    await store.organizationMember.create({
      data: { organizationId: "org-1", userId: "user-1", role: "OWNER" },
    })
    await seedMembership({
      workspaceId: "ws-2",
      workspaceName: "Other workspace",
      orgId: "org-2",
      orgName: "Other organization",
      role: "MEMBER",
    })

    expect(
      await revalidateRememberedBinding({ authorizationMode: "USER", agentId: null }, "user-1"),
    ).toBeNull()
  })
})
