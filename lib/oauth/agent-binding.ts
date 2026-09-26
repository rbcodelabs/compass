/**
 * What the consent screen is allowed to offer, and what the consent POST is
 * allowed to accept (ADR 0015, stage 2).
 *
 * Stage 1 added `authorization_mode` / `agent_id` to the code, token and
 * consent rows and taught `validateOAuthAccessToken` to branch on them. Nothing
 * wrote `"AGENT"`. This module is the half that decides *which* binding a human
 * may elect, computes what that binding would actually reach, and re-validates
 * the elected binding server-side when the form comes back.
 *
 * ## Three sets, and why they are different sizes
 *
 * The screen deals with three distinct sets of workspaces, and conflating any
 * two of them produces a specific, shippable bug:
 *
 *  - **Membership** — every workspace the user belongs to. This is what a
 *    `purpose: "USER"` token reaches and what the Phase 1 screen enumerated
 *    (`grantedAccess`, lib/oauth/consent.ts). It is *not* what an agent-bound
 *    token reaches, so showing it beside an agent selection would overstate the
 *    grant on the one screen whose job is to state it accurately.
 *  - **Grantable** — the subset the user may grant an agent access to *here*:
 *    workspaces where they are a member **and** an administrator. Narrower than
 *    membership, often dramatically so. See {@link selectGrantableWorkspaces}.
 *  - **Effective reach** — what a *specific* agent reaches right now: its
 *    unrevoked grants, intersected with the owner's current memberships. This
 *    is the set the token will actually see, because that intersection is
 *    literally what `agentWorkspaceWhere` computes (lib/agent-access.ts:13-17 —
 *    `members: { some: { userId } }` AND `id: { in: grantedWorkspaceIds }`).
 *    An agent holding a grant in a workspace its owner has since left reaches
 *    nothing there, so listing that grant as reach would be a lie.
 *
 * ## Zero reach is the failure this module exists to prevent
 *
 * An agent with no effective reach yields a token that authenticates, passes
 * every scope check and every tool gate, and then answers *"Workspace not found
 * or access denied."* to every call. That is a connection which reports success
 * and does nothing — strictly worse than refusing to connect, because the
 * client, the user and the logs all agree it worked. Both the screen and
 * {@link resolveConsentBinding} refuse it.
 */
import getPrisma from "@/lib/db"
import { isOrgAdminRole, normalizeWorkspaceRole } from "@/lib/roles"
import { SCOPE_MCP_WRITE } from "@/lib/oauth/constants"
import type { AuthorizationBinding } from "@/lib/oauth/codes"

/** One workspace an agent may be granted access to at consent time. */
export interface GrantableWorkspace {
  id: string
  name: string
  slug: string
  organizationId: string
  organizationName: string
  organizationSlug: string
}

/** One workspace a chosen agent can actually reach, and at what level. */
export interface AgentReachEntry {
  workspaceId: string
  workspaceName: string
  organizationName: string
  access: "READ" | "WRITE"
}

/** An agent the authorizing user may bind this connection to. */
export interface BindableAgent {
  id: string
  name: string
  /** Empty means this agent would mint a dead credential. */
  reach: AgentReachEntry[]
}

/** Everything the consent screen needs in order to render the binding section. */
export interface ConsentBindingOptions {
  /** `COMPASS_AGENTS_ENABLED`. Off means Phase 1 behavior verbatim. */
  agentsEnabled: boolean
  agents: BindableAgent[]
  grantable: GrantableWorkspace[]
  /** True when the admin-override disclosure may be rendered at all. */
  overrideAvailable: boolean
  /** Memberships pointing at a deleted workspace or organization. */
  unresolvedMemberships: number
}

// ── the three sets, as pure functions ─────────────────────────────────────

/**
 * A `WorkspaceMember` row, joined to its workspace, organization, and the
 * user's role in that organization.
 *
 * Both relations are typed nullable on purpose. `relationMode = "prisma"` means
 * the database enforces no foreign keys and performs no cascade deletes, so a
 * deleted workspace leaves its membership rows behind pointing at nothing while
 * Prisma's generated type still insists the relation is present. Same hazard,
 * same handling, as `grantedAccess` in lib/oauth/consent.ts.
 */
export interface WorkspaceMembershipRow {
  /** The user's `WorkspaceMember.role`, raw from the column. */
  role: string | null
  workspace: {
    id: string
    name: string
    slug: string
    organization: {
      id: string
      name: string
      slug: string
      /** The user's `OrganizationMember` row, if they have one. */
      members: Array<{ role: string | null }>
    } | null
  } | null
}

/**
 * The workspaces this user may grant one of their own agents access to.
 *
 * **This predicate is deliberately narrow and must not be loosened.** It is the
 * exact predicate `grantWorkspaceAgent` already enforces
 * (app/settings/agents/actions.ts:62-83 → `resolveWorkspaceAdmin`,
 * lib/permissions.ts:128-134): workspace ADMIN, or ADMIN/OWNER of the
 * containing organization. Relaxing it here so that consent could grant more
 * than Settings can would quietly undo the delegation model this whole change
 * exists to restore — and it would do so on the one screen a third party gets
 * to put in front of the user.
 *
 * The consequence is not hidden anywhere: for a plain member of someone else's
 * organization this set is **empty**, and the screen says so in those words
 * rather than presenting a short list as if it were complete.
 *
 * Roles are normalised rather than compared exactly, because both columns are
 * bare `VarChar`s that have historically held "OWNER" and lowercase values —
 * an exact match against "ADMIN" would exclude the person who created the
 * workspace. One definition of admin, in lib/roles.ts.
 */
export function selectGrantableWorkspaces(
  rows: readonly WorkspaceMembershipRow[],
): { grantable: GrantableWorkspace[]; unresolved: number } {
  const grantable: GrantableWorkspace[] = []
  const seen = new Set<string>()
  let unresolved = 0

  for (const row of rows) {
    const workspace = row.workspace
    if (!workspace || !workspace.organization) {
      unresolved += 1
      continue
    }
    const organization = workspace.organization
    const isWorkspaceAdmin = normalizeWorkspaceRole(row.role) === "ADMIN"
    const isOrgAdmin = isOrgAdminRole(organization.members[0]?.role)
    if (!isWorkspaceAdmin && !isOrgAdmin) continue
    // A duplicate membership row is a data defect, not a second workspace.
    if (seen.has(workspace.id)) continue
    seen.add(workspace.id)
    grantable.push({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      organizationId: organization.id,
      organizationName: organization.name,
      organizationSlug: organization.slug,
    })
  }

  const collator = new Intl.Collator("en")
  grantable.sort(
    (a, b) =>
      collator.compare(a.organizationName, b.organizationName) || collator.compare(a.name, b.name),
  )
  return { grantable, unresolved }
}

/**
 * May this user elect the admin override — a `purpose: "USER"` token with no
 * agent binding, carrying their full reach across every organization?
 *
 * The predicate is **OWNER or ADMIN of every organization the user belongs
 * to**, and it is the only coherent rule available. "Admin of at least one org"
 * is incoherent: being an admin of org A does not justify unrestricted reach
 * into org B, and a user-mode token carries reach into both. Requiring admin
 * everywhere means the user already personally holds every authority the token
 * would carry, which is the property an escalation gate should be checking.
 *
 * **A user with no organization memberships does not qualify.** `every` over an
 * empty list is vacuously true, and a vacuous truth is the wrong way to acquire
 * an escalation right — the rule is "you already hold this authority", and
 * holding it nowhere is not holding it everywhere. Such a user also has no
 * reach to escalate to, so the override would do nothing except exist.
 */
export function overridePredicateHolds(orgRoles: ReadonlyArray<string | null>): boolean {
  if (orgRoles.length === 0) return false
  return orgRoles.every((role) => isOrgAdminRole(role))
}

/**
 * Roles to feed the admin-everywhere predicate, covering every organization
 * the user can reach through either membership table.
 *
 * `WorkspaceMember` is independently sufficient for USER-mode workspace
 * reach. With `relationMode = "prisma"`, it can exist without the matching
 * `OrganizationMember` row, so checking only organization memberships would
 * omit an organization from the escalation gate. A missing org role is
 * represented as `null` and therefore fails closed.
 */
function overrideRolesForMemberships(
  workspaceMemberships: readonly WorkspaceMembershipRow[],
  organizationMemberships: ReadonlyArray<{ organizationId: string; role: string | null }>,
): Array<string | null> {
  const rolesByOrganization = new Map<string, string | null>()
  for (const membership of organizationMemberships) {
    rolesByOrganization.set(membership.organizationId, membership.role)
  }
  for (const membership of workspaceMemberships) {
    const organization = membership.workspace?.organization
    if (!organization || rolesByOrganization.has(organization.id)) continue
    rolesByOrganization.set(organization.id, organization.members[0]?.role ?? null)
  }
  return [...rolesByOrganization.values()]
}

/**
 * What one agent can actually reach: unrevoked grants ∩ the owner's current
 * memberships, which is precisely the pair of conditions `agentWorkspaceWhere`
 * ANDs together. A grant in a workspace the owner has left is dropped, because
 * the token would find nothing there either.
 */
export function selectAgentReach(
  grants: ReadonlyArray<{ agentId: string; workspaceId: string; access: string }>,
  memberWorkspaces: ReadonlyMap<string, { name: string; organizationName: string }>,
): Map<string, AgentReachEntry[]> {
  const byAgent = new Map<string, AgentReachEntry[]>()
  for (const grant of grants) {
    const workspace = memberWorkspaces.get(grant.workspaceId)
    if (!workspace) continue
    const entries = byAgent.get(grant.agentId) ?? []
    entries.push({
      workspaceId: grant.workspaceId,
      workspaceName: workspace.name,
      organizationName: workspace.organizationName,
      // Anything that is not exactly "WRITE" is read access. A stray value in a
      // bare VarChar must never widen a grant, and `agentWorkspaceWhere` filters
      // on `access: "WRITE"` exactly, so this matches what the token will see.
      access: grant.access === "WRITE" ? "WRITE" : "READ",
    })
    byAgent.set(grant.agentId, entries)
  }
  const collator = new Intl.Collator("en")
  for (const entries of byAgent.values()) {
    entries.sort(
      (a, b) =>
        collator.compare(a.organizationName, b.organizationName) ||
        collator.compare(a.workspaceName, b.workspaceName),
    )
  }
  return byAgent
}

/**
 * The access level an inline-created agent is granted in the workspaces the
 * user ticks.
 *
 * Derived from the scopes the client asked for rather than offered as a third
 * control. The design names the rough edge this avoids: a token holding
 * `mcp:write` bound to an agent with READ-only grants passes the pre-dispatch
 * scope check and then fails per-tool with "Workspace not found or access
 * denied", which is a correct diagnosis pointing at the wrong layer. Matching
 * the grant to the verb the connection actually asked for removes that mismatch
 * at the only moment we get to choose both. The screen states the level in
 * words, so it is disclosed rather than inferred silently.
 */
export function inlineGrantAccess(requestedScopes: readonly string[]): "READ" | "WRITE" {
  return requestedScopes.includes(SCOPE_MCP_WRITE) ? "WRITE" : "READ"
}

export const AGENTS_ENABLED_ENV = "COMPASS_AGENTS_ENABLED"

/** Read directly rather than imported from lib/agent-access, which pulls in Prisma types. */
function agentsAreEnabled(): boolean {
  return process.env[AGENTS_ENABLED_ENV] === "1"
}

// ── loading ───────────────────────────────────────────────────────────────

/**
 * Everything the binding section needs, in two round trips.
 *
 * When agents are disabled the agent queries are skipped entirely: the section
 * is not rendered, so there is nothing to populate, and the consent screen
 * falls back to exactly its Phase 1 behavior. The flag's off-state being the
 * currently shipped behavior is what makes it usable as a rollout control.
 */
export async function loadConsentBindingOptions(userId: string): Promise<ConsentBindingOptions> {
  const prisma = getPrisma()
  const agentsEnabled = agentsAreEnabled()

  const [memberships, orgMemberships] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { userId },
      select: {
        role: true,
        workspace: {
          select: {
            id: true,
            name: true,
            slug: true,
            organization: {
              select: {
                id: true,
                name: true,
                slug: true,
                members: { where: { userId }, select: { role: true } },
              },
            },
          },
        },
      },
    }),
    prisma.organizationMember.findMany({
      where: { userId },
      select: { organizationId: true, role: true },
    }),
  ])

  const rows = memberships as unknown as WorkspaceMembershipRow[]
  const { grantable, unresolved } = selectGrantableWorkspaces(rows)
  const overrideAvailable = overridePredicateHolds(overrideRolesForMemberships(rows, orgMemberships))

  if (!agentsEnabled) {
    return { agentsEnabled, agents: [], grantable, overrideAvailable, unresolvedMemberships: unresolved }
  }

  const agentRows = await prisma.agent.findMany({
    where: { ownerUserId: userId, status: "ACTIVE" },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  })
  const grants = agentRows.length
    ? await prisma.agentWorkspaceGrant.findMany({
        where: { agentId: { in: agentRows.map((agent) => agent.id) }, revokedAt: null },
        select: { agentId: true, workspaceId: true, access: true },
      })
    : []

  const memberWorkspaces = new Map<string, { name: string; organizationName: string }>()
  for (const row of rows) {
    if (!row.workspace || !row.workspace.organization) continue
    memberWorkspaces.set(row.workspace.id, {
      name: row.workspace.name,
      organizationName: row.workspace.organization.name,
    })
  }
  const reachByAgent = selectAgentReach(grants, memberWorkspaces)

  return {
    agentsEnabled,
    agents: agentRows.map((agent) => ({ ...agent, reach: reachByAgent.get(agent.id) ?? [] })),
    grantable,
    overrideAvailable,
    unresolvedMemberships: unresolved,
  }
}

/**
 * Whether USER-mode OAuth would carry no authority the user does not already
 * hold as an administrator. The organization set is the union of both
 * membership tables; a workspace-only membership has no organization role and
 * therefore fails closed.
 */
export async function isUserOverrideEligible(userId: string): Promise<boolean> {
  const prisma = getPrisma()
  const [workspaceMemberships, orgMemberships] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { userId },
      select: {
        role: true,
        workspace: {
          select: {
            id: true,
            name: true,
            slug: true,
            organization: {
              select: {
                id: true,
                name: true,
                slug: true,
                members: { where: { userId }, select: { role: true } },
              },
            },
          },
        },
      },
    }),
    prisma.organizationMember.findMany({
      where: { userId },
      select: { organizationId: true, role: true },
    }),
  ])
  return overridePredicateHolds(
    overrideRolesForMemberships(
      workspaceMemberships as unknown as WorkspaceMembershipRow[],
      orgMemberships,
    ),
  )
}

// ── resolving a submitted binding ─────────────────────────────────────────

/** The unsigned fields the consent POST accepts. See the invariant amendment
 *  in app/oauth/consent/route.ts. */
export interface SubmittedBinding {
  /** `"agent"`, `"new"` or `"user"`. Anything else is rejected. */
  binding: string | null
  agentId: string | null
  agentName: string | null
  grantWorkspaceIds: readonly string[]
  confirmation: string | null
}

export type ResolvedBinding =
  | { ok: true; binding: Required<AuthorizationBinding>; createdAgentId: string | null }
  | { ok: false; message: string }

/** Side-effecting collaborators, injected so the resolver is testable without
 *  a server-action module graph. */
export interface BindingEffects {
  createAgent(name: string): Promise<{ id: string }>
  grantWorkspace(
    orgSlug: string,
    workspaceSlug: string,
    agentId: string,
    access: "READ" | "WRITE",
  ): Promise<void>
  deleteAgent(agentId: string): Promise<void>
}

/**
 * Re-validates a submitted binding against the session user and turns it into
 * the two columns an authorization code carries.
 *
 * **Every field here arrived unsigned**, so nothing is trusted: the named agent
 * must be one of the caller's own live agents, every ticked workspace must be
 * in the caller's grantable set, the override predicate must hold *now*, and
 * the typed confirmation must equal the caller's own email. The worst a
 * tampered field can therefore achieve is a binding the user was independently
 * entitled to choose — which is a different class of outcome from the
 * redirect-URI substitution the signed blob exists to prevent, and the reason
 * accepting unsigned fields here is defensible.
 *
 * Messages are user-facing and name the remedy. They deliberately do not
 * distinguish "no such agent" from "not your agent": both are answered as
 * unavailable, because the difference is only interesting to someone probing
 * for other people's agent ids.
 */
export async function resolveConsentBinding(
  submitted: SubmittedBinding,
  context: {
    userId: string
    userEmail: string | null
    requestedScopes: readonly string[]
    options: ConsentBindingOptions
  },
  effects: BindingEffects,
): Promise<ResolvedBinding> {
  const { options } = context

  // The flag is checked before the choice, not after. With agents off there is
  // no binding section on the screen, so any binding field in the body is
  // either a stale form or a hand-rolled POST; both get Phase 1 behavior.
  if (!options.agentsEnabled) {
    return { ok: true, binding: { authorizationMode: "USER", agentId: null }, createdAgentId: null }
  }

  switch (submitted.binding) {
    case "agent": {
      const agent = options.agents.find((candidate) => candidate.id === submitted.agentId)
      if (!agent) {
        return { ok: false, message: "That agent is not available. Start the authorization again." }
      }
      if (agent.reach.length === 0) {
        return { ok: false, message: zeroReachMessage(agent.name) }
      }
      return { ok: true, binding: { authorizationMode: "AGENT", agentId: agent.id }, createdAgentId: null }
    }

    case "new": {
      const name = (submitted.agentName ?? "").trim()
      if (!name || name.length > 120) {
        return { ok: false, message: "Give the new agent a name of 1–120 characters." }
      }
      // Validated against the grantable set *before* anything is created, so a
      // tampered workspace id cannot leave a half-granted agent behind.
      const chosen: GrantableWorkspace[] = []
      for (const id of new Set(submitted.grantWorkspaceIds)) {
        const workspace = options.grantable.find((candidate) => candidate.id === id)
        if (!workspace) {
          return {
            ok: false,
            message: "You are not an administrator of one of the workspaces selected.",
          }
        }
        chosen.push(workspace)
      }
      if (chosen.length === 0) {
        return { ok: false, message: zeroReachMessage(name) }
      }

      const access = inlineGrantAccess(context.requestedScopes)
      const created = await effects.createAgent(name)
      try {
        for (const workspace of chosen) {
          await effects.grantWorkspace(
            workspace.organizationSlug,
            workspace.slug,
            created.id,
            access,
          )
        }
      } catch (error) {
        // A grant failed — a concurrent demotion, or the membership-touch guard
        // in grantWorkspaceAgent losing its race. Roll the agent back rather
        // than leaving a partially-granted one behind, because a
        // partially-granted agent is exactly the under-reaching credential this
        // module refuses to mint, and it would be invisible until it failed.
        await effects.deleteAgent(created.id).catch(() => {})
        return {
          ok: false,
          message:
            error instanceof Error && error.message
              ? `The agent could not be granted access: ${error.message}`
              : "The agent could not be granted access. Start the authorization again.",
        }
      }
      return {
        ok: true,
        binding: { authorizationMode: "AGENT", agentId: created.id },
        createdAgentId: created.id,
      }
    }

    case "user": {
      if (!options.overrideAvailable) {
        return {
          ok: false,
          message:
            "Authorizing as yourself requires you to be an owner or administrator of every organization you belong to.",
        }
      }
      const expected = (context.userEmail ?? "").trim().toLowerCase()
      const typed = (submitted.confirmation ?? "").trim().toLowerCase()
      if (!expected || typed !== expected) {
        return {
          ok: false,
          message: "Type your own email address exactly to confirm full account access.",
        }
      }
      return { ok: true, binding: { authorizationMode: "USER", agentId: null }, createdAgentId: null }
    }

    default:
      // Missing or unrecognised. Never read as an approval of anything — the
      // user is sent back to make a choice rather than being defaulted into
      // one, because both available defaults are wrong: "USER" is the
      // escalation and "AGENT" needs an agent id this body did not carry.
      return { ok: false, message: "Choose which identity this application should act as." }
  }
}

function zeroReachMessage(agentName: string): string {
  return `${agentName} cannot reach any workspace, so this connection would fail every request. Ask a workspace administrator to grant it access first.`
}

/**
 * Re-validates a *remembered* binding before replaying it.
 *
 * A stored consent row is replayed without showing the screen, so the binding
 * on it has to be checked against the world as it is now, not as it was when
 * it was stored. An agent that has since been suspended, deleted or unowned
 * would otherwise mint a token that 401s on its first call — the client would
 * see a successful authorization followed immediately by an authentication
 * failure, with no way to tell it needs to re-consent.
 *
 * Returning `null` means "do not replay": the caller falls through to the
 * consent screen, which is always a safe answer because the worst case is one
 * extra click.
 */
export async function revalidateRememberedBinding(
  stored: { authorizationMode: string | null; agentId: string | null },
  userId: string,
): Promise<Required<AuthorizationBinding> | null> {
  if (stored.authorizationMode === "USER") {
    // The override predicate is re-checked, so losing org-admin rights narrows
    // the next reconnect rather than the next 30 days.
    if (!agentsAreEnabled()) return { authorizationMode: "USER", agentId: null }
    if (!(await isUserOverrideEligible(userId))) return null
    return { authorizationMode: "USER", agentId: null }
  }

  if (stored.authorizationMode !== "AGENT") return null

  if (!agentsAreEnabled() || !stored.agentId) return null
  const prisma = getPrisma()
  const agent = await prisma.agent.findFirst({
    where: { id: stored.agentId, ownerUserId: userId, status: "ACTIVE" },
    select: { id: true },
  })
  if (!agent) return null
  // Reach is re-checked too, not just liveness: every grant can be revoked
  // between authorizations, and replaying a binding whose reach has gone to
  // zero re-mints the dead credential this module refuses to create.
  const grants = await prisma.agentWorkspaceGrant.findMany({
    where: { agentId: stored.agentId, revokedAt: null },
    select: { workspaceId: true },
  })
  if (grants.length === 0) return null
  const reachable = await prisma.workspace.findFirst({
    where: { id: { in: grants.map((grant) => grant.workspaceId) }, members: { some: { userId } } },
    select: { id: true },
  })
  if (!reachable) return null
  return { authorizationMode: "AGENT", agentId: stored.agentId }
}
