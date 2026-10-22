import type { AppPrismaClient } from "@/lib/db"
import { isOrgAdminRole, normalizeWorkspaceRole } from "@/lib/roles"

/**
 * The one place that decides who owns an Agent and what that ownership allows
 * (ADR "Cloud agents as first-class identities").
 *
 *   USER-owned      Unchanged from before the ADR: the agent acts with the delegated authority of
 *                   its owner, including the owner's live org-admin rights.
 *   WORKSPACE-owned Inherits NOTHING. It acts only through explicit AgentWorkspaceGrant rows, and an
 *                   AgentOrgAdminGrant still needs a live human grantedByUserId.
 *
 * Rows that predate migration 098 have NULL kind / owner_type and read as EXTERNAL / USER, and the
 * helpers below keep working while the migration is unapplied (see {@link withAgentColumns}).
 * Nothing outside this module should compare `agent.ownerUserId` directly: a WORKSPACE-owned agent
 * has no owner user, and a raw comparison is exactly how it would silently inherit authority.
 */

export type AgentKind = "EXTERNAL" | "CLOUD"
export type AgentOwnerType = "USER" | "WORKSPACE"
export type AgentInvokePolicy = "WORKSPACE_MEMBERS" | "ADMINS" | "OWNER"
export type AgentOwner = { type: "USER"; userId: string } | { type: "WORKSPACE"; workspaceId: string }

/** A top-level client only: see {@link withAgentColumns} for why a transaction client must not reach these helpers. */
type AgentDb = AppPrismaClient

/** The columns that exist with or without migration 098. */
export const AGENT_LEGACY_SELECT = {
  id: true,
  ownerUserId: true,
  name: true,
  description: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const

/** Legacy columns plus the ones migration 098 adds. */
export const AGENT_OWNERSHIP_SELECT = {
  ...AGENT_LEGACY_SELECT,
  kind: true,
  ownerType: true,
  ownerWorkspaceId: true,
  instructions: true,
  model: true,
  invokePolicy: true,
} as const

/**
 * What the helpers read. The 098 fields are optional because the row may come from a database
 * where the migration has not run (the field is then absent, which reads as the legacy default).
 */
export type AgentRecord = {
  id: string
  ownerUserId: string | null
  name: string
  description?: string | null
  status: string
  createdAt?: Date
  updatedAt?: Date
  kind?: string | null
  ownerType?: string | null
  ownerWorkspaceId?: string | null
  instructions?: string | null
  model?: string | null
  invokePolicy?: string | null
}

// ── Reading ownership (pure) ───────────────────────────────────────────────

export function agentKind(agent: Pick<AgentRecord, "kind">): AgentKind {
  return agent.kind === "CLOUD" ? "CLOUD" : "EXTERNAL"
}

/**
 * Who owns this agent, or `null` when the row is inconsistent (an unknown owner type, a USER agent
 * with no owner user, a WORKSPACE agent with no workspace). Callers treat `null` as "owned by
 * nobody": every authority check fails closed on it.
 */
export function agentOwner(agent: Pick<AgentRecord, "ownerUserId" | "ownerType" | "ownerWorkspaceId">): AgentOwner | null {
  const type = agent.ownerType ?? "USER"
  if (type === "USER") return agent.ownerUserId ? { type: "USER", userId: agent.ownerUserId } : null
  if (type === "WORKSPACE") return agent.ownerWorkspaceId ? { type: "WORKSPACE", workspaceId: agent.ownerWorkspaceId } : null
  return null
}

/** True only for a USER-owned agent whose owner is `userId`. A WORKSPACE-owned agent is never user-owned. */
export function isUserOwnedBy(agent: Pick<AgentRecord, "ownerUserId" | "ownerType" | "ownerWorkspaceId">, userId: string | null | undefined): boolean {
  const owner = agentOwner(agent)
  return !!userId && owner?.type === "USER" && owner.userId === userId
}

export function isWorkspaceOwned(agent: Pick<AgentRecord, "ownerUserId" | "ownerType" | "ownerWorkspaceId">): boolean {
  return agentOwner(agent)?.type === "WORKSPACE"
}

/**
 * Default invoke policy by owner type: a personal agent is for its owner, a shared one for the
 * workspace. A stored but unrecognized value falls back to the most restrictive policy.
 */
export function agentInvokePolicy(agent: Pick<AgentRecord, "ownerUserId" | "ownerType" | "ownerWorkspaceId" | "invokePolicy">): AgentInvokePolicy {
  const stored = agent.invokePolicy
  if (stored === "WORKSPACE_MEMBERS" || stored === "ADMINS" || stored === "OWNER") return stored
  if (stored) return "OWNER"
  return agentOwner(agent)?.type === "WORKSPACE" ? "WORKSPACE_MEMBERS" : "OWNER"
}

/**
 * Whether an ALREADY AUTHENTICATED agent identity (an agentId that mcp-auth accepted) is still
 * valid for the user the request carries. USER-owned: that user must be the owner, as before.
 * WORKSPACE-owned: always false here. A request that carries a user id says nothing about a shared
 * agent, so accepting an arbitrary (or null) user would let any personal credential name it. Reaching
 * a WORKSPACE-owned agent needs an agent-scoped AGENT_TURN credential for that exact agent, checked by
 * {@link agentIdentityValidForTurn}, never by this function.
 */
export function agentIdentityValidForUser(agent: Pick<AgentRecord, "status" | "ownerUserId" | "ownerType" | "ownerWorkspaceId">, userId: string | null | undefined): boolean {
  if (agent.status !== "ACTIVE") return false
  const owner = agentOwner(agent)
  if (!owner || owner.type !== "USER") return false
  return isUserOwnedBy(agent, userId)
}

/**
 * Whether an ALREADY AUTHENTICATED AGENT_TURN credential (the key a cloud run's sandbox holds) may act as
 * `agent`. The credential must be tied to this exact agent (`turn.agentId`) and to a live run
 * (`turn.runId`, set by validateMcpAuth only after it found a non-terminal, unexpired run bound to the key).
 * The agent must be a CLOUD agent and ACTIVE.
 *
 * USER-owned: the invoker must still be the owner, so the effective authority is the owner's own (grants
 * intersected with the owner's live membership, enforced where the grants are read). WORKSPACE-owned: no
 * user is involved in the identity at all; whether the invoker may run the agent was decided by
 * {@link canInvokeAgent} when the run was created, and the authority is its explicit grants only.
 */
export function agentIdentityValidForTurn(
  agent: Pick<AgentRecord, "id" | "status" | "kind" | "ownerUserId" | "ownerType" | "ownerWorkspaceId">,
  turn: { agentId: string | null | undefined; invokerUserId: string | null | undefined; runId: string | null | undefined },
): boolean {
  if (agent.status !== "ACTIVE" || agentKind(agent) !== "CLOUD") return false
  if (!turn.runId || !turn.agentId || turn.agentId !== agent.id) return false
  const owner = agentOwner(agent)
  if (!owner) return false
  if (owner.type === "USER") return !!turn.invokerUserId && owner.userId === turn.invokerUserId
  return true
}

/**
 * Whether an agent may be assigned work in `context.workspaceId`. Needs a live grant either way. A
 * USER-owned agent also needs its owner to still be a workspace member; a WORKSPACE-owned agent has
 * no owner user to be a member, but is usable only in the workspace that owns it.
 */
export function agentEligibleInWorkspace(
  agent: Pick<AgentRecord, "status" | "ownerUserId" | "ownerType" | "ownerWorkspaceId">,
  context: { workspaceId: string; hasLiveGrant: boolean; memberUserIds: ReadonlySet<string> },
): boolean {
  if (agent.status !== "ACTIVE" || !context.hasLiveGrant) return false
  const owner = agentOwner(agent)
  if (!owner) return false
  return owner.type === "WORKSPACE" ? owner.workspaceId === context.workspaceId : context.memberUserIds.has(owner.userId)
}

// ── Tolerating an unapplied migration ──────────────────────────────────────

const AVAILABILITY_NEGATIVE_TTL_MS = 30_000
let columnsAvailability: { value: boolean; checkedAt: number } | null = null

/** Matches `agents.<new column>` or a quoted new column name, in Prisma's and PostgreSQL's wording. */
const NEW_COLUMN_REFERENCE = /(?:agents\.|["'`])(?:kind|owner_type|owner_workspace_id|instructions|model|invoke_policy|ownerType|ownerWorkspaceId|invokePolicy)\b/

/** A missing-column error that names a column migration 098 adds; any other missing column is a real fault. */
function isMissingColumnError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const message = error instanceof Error ? error.message : ""
  const meta = "meta" in error && typeof error.meta === "object" && error.meta !== null ? JSON.stringify(error.meta) : ""
  const isMissingColumn = ("code" in error && error.code === "P2022") || /column .*does not exist/i.test(message)
  return isMissingColumn && NEW_COLUMN_REFERENCE.test(`${message} ${meta}`)
}

type ColumnContext = { select: typeof AGENT_OWNERSHIP_SELECT | typeof AGENT_LEGACY_SELECT; extended: boolean }

/**
 * Runs `run` with the ownership columns selected, and falls back to the legacy column set when
 * the database has not applied migration 098 yet (Prisma selects every mapped column, so a model
 * field with no column would otherwise fail every agent query). `extended` tells the callback
 * whether it may reference the new columns in a `where`. A missing column is the only error
 * swallowed; anything else is a real fault and is rethrown.
 *
 * NEVER call this with a client that is inside an interactive transaction. A failed statement
 * aborts the whole PostgreSQL transaction, so the retry would fail too, and a transaction client
 * cannot be told apart from a top-level one at runtime (Prisma leaves `$transaction` on it). The
 * helpers in this module therefore take a top-level client ({@link AgentDb}); code that runs in a
 * transaction must query agents directly with {@link AGENT_LEGACY_SELECT} or a plain `id` select.
 */
export async function withAgentColumns<T>(run: (ctx: ColumnContext) => Promise<T>): Promise<T> {
  if (columnsAvailability && !columnsAvailability.value && Date.now() - columnsAvailability.checkedAt < AVAILABILITY_NEGATIVE_TTL_MS) {
    return run({ select: AGENT_LEGACY_SELECT, extended: false })
  }
  try {
    const result = await run({ select: AGENT_OWNERSHIP_SELECT, extended: true })
    columnsAvailability = { value: true, checkedAt: Date.now() }
    return result
  } catch (error) {
    if (!isMissingColumnError(error)) throw error
    columnsAvailability = { value: false, checkedAt: Date.now() }
    return run({ select: AGENT_LEGACY_SELECT, extended: false })
  }
}

/** Test seam: forget the probe result so a suite can exercise both branches. */
export function resetAgentColumnsAvailabilityCache() {
  columnsAvailability = null
}

// ── Loading ────────────────────────────────────────────────────────────────

export async function findAgentById(prisma: AgentDb, id: string): Promise<AgentRecord | null> {
  return withAgentColumns(({ select }) => prisma.agent.findFirst({ where: { id }, select })) as Promise<AgentRecord | null>
}

export async function findAgentsByIds(prisma: AgentDb, ids: string[]): Promise<AgentRecord[]> {
  if (ids.length === 0) return []
  return withAgentColumns(({ select }) => prisma.agent.findMany({ where: { id: { in: ids } }, select })) as Promise<AgentRecord[]>
}

/**
 * The agent when it is ACTIVE and USER-owned by `userId`; otherwise null. This is the check for a
 * personal credential (API key, OAuth token or binding): only a USER-owned agent can be reached
 * with one in this release, so a WORKSPACE-owned agent fails closed here. A shared agent is reached only by
 * an AGENT_TURN key tied to a live run (see agentIdentityValidForTurn).
 */
export async function findActiveUserOwnedAgent(prisma: AgentDb, agentId: string, userId: string): Promise<AgentRecord | null> {
  const agent = await findAgentById(prisma, agentId)
  return agent && agent.status === "ACTIVE" && isUserOwnedBy(agent, userId) ? agent : null
}

/** USER-owned agents of `userId`, optionally only the ACTIVE ones. */
export async function listUserOwnedAgents(prisma: AgentDb, userId: string, options: { status?: "ACTIVE"; orderBy?: "name" | "createdAt" } = {}): Promise<AgentRecord[]> {
  const rows = (await withAgentColumns(({ select }) =>
    prisma.agent.findMany({ where: { ownerUserId: userId, ...(options.status ? { status: options.status } : {}) }, select, orderBy: { [options.orderBy ?? "name"]: "asc" } }),
  )) as AgentRecord[]
  // ownerUserId alone could match a malformed WORKSPACE row, so the owner type is re-read in memory.
  return rows.filter((agent) => isUserOwnedBy(agent, userId))
}

/**
 * ACTIVE agents owned by one of `userIds` (USER-owned) or by one of `workspaceIds`
 * (WORKSPACE-owned). Used for org-level listings, where the owners are the org's members and
 * workspaces.
 */
export async function listActiveAgentsOwnedBy(prisma: AgentDb, owners: { userIds: string[]; workspaceIds: string[] }): Promise<AgentRecord[]> {
  const rows = (await withAgentColumns(({ select, extended }) =>
    prisma.agent.findMany({
      where: {
        status: "ACTIVE",
        OR: [
          ...(owners.userIds.length ? [{ ownerUserId: { in: owners.userIds } }] : []),
          ...(extended && owners.workspaceIds.length ? [{ ownerWorkspaceId: { in: owners.workspaceIds } }] : []),
        ],
      },
      select,
      orderBy: { name: "asc" },
    }),
  )) as AgentRecord[]
  const users = new Set(owners.userIds)
  const workspaces = new Set(owners.workspaceIds)
  return rows.filter((agent) => {
    const owner = agentOwner(agent)
    return owner?.type === "USER" ? users.has(owner.userId) : owner?.type === "WORKSPACE" ? workspaces.has(owner.workspaceId) : false
  })
}

/**
 * The agents a workspace's settings page lists: those with a live grant here, plus (for a viewer
 * who manages the workspace) agents that could be granted: USER-owned by a current member, and
 * WORKSPACE-owned by this workspace.
 */
export async function listAgentsForWorkspace(
  prisma: AgentDb,
  workspaceId: string,
  scope: { memberUserIds: string[]; grantedAgentIds: string[]; includeGrantable: boolean },
): Promise<AgentRecord[]> {
  const rows = (await withAgentColumns(({ select, extended }) =>
    prisma.agent.findMany({
      where: {
        OR: [
          { id: { in: scope.grantedAgentIds } },
          ...(scope.includeGrantable ? [{ ownerUserId: { in: scope.memberUserIds } }] : []),
          ...(scope.includeGrantable && extended ? [{ ownerWorkspaceId: workspaceId }] : []),
        ],
      },
      select,
      orderBy: { name: "asc" },
    }),
  )) as AgentRecord[]
  const members = new Set(scope.memberUserIds)
  const granted = new Set(scope.grantedAgentIds)
  return rows.filter((agent) => {
    if (granted.has(agent.id)) return true
    if (!scope.includeGrantable) return false
    const owner = agentOwner(agent)
    if (owner?.type === "USER") return members.has(owner.userId)
    return owner?.type === "WORKSPACE" && owner.workspaceId === workspaceId
  })
}

// ── Authority (async: reads live membership) ───────────────────────────────

/**
 * Workspace admin in the same sense as assertWorkspaceAdmin (lib/mcp-authz.ts): a workspace ADMIN
 * member, or an OWNER/ADMIN of the owning organization even when not a member of the workspace. An
 * org admin can already administer every workspace in their org (and add themselves to it), so
 * excluding them here would only lock them out of a shared agent their organization owns.
 */
export async function isWorkspaceAdminUser(prisma: AgentDb, userId: string, workspaceId: string): Promise<boolean> {
  const workspace = await prisma.workspace.findFirst({
    where: { id: workspaceId },
    select: {
      members: { where: { userId }, select: { role: true } },
      organization: { select: { members: { where: { userId }, select: { role: true } } } },
    },
  })
  if (!workspace) return false
  return normalizeWorkspaceRole(workspace.members[0]?.role) === "ADMIN" || isOrgAdminRole(workspace.organization?.members[0]?.role)
}

async function isWorkspaceMemberUser(prisma: AgentDb, userId: string, workspaceId: string): Promise<boolean> {
  return !!(await prisma.workspaceMember.findFirst({ where: { workspaceId, userId }, select: { id: true } }))
}

/**
 * May `actor` edit, suspend or re-key this agent? USER-owned: its owner. WORKSPACE-owned: an admin
 * of the owning workspace. Anyone else, and any inconsistent row, is refused.
 */
export async function canManageAgent(prisma: AgentDb, actor: { userId: string | null | undefined }, agent: Pick<AgentRecord, "ownerUserId" | "ownerType" | "ownerWorkspaceId">): Promise<boolean> {
  if (!actor.userId) return false
  const owner = agentOwner(agent)
  if (!owner) return false
  if (owner.type === "USER") return owner.userId === actor.userId
  return isWorkspaceAdminUser(prisma, actor.userId, owner.workspaceId)
}

/**
 * May `actor` start a run as this agent? The agent must be ACTIVE. A USER-owned agent can be
 * invoked only by its owner whatever its stored policy says: letting others invoke a personal
 * agent needs the intersection rule from the ADR's open questions. A WORKSPACE-owned agent follows
 * its policy: WORKSPACE_MEMBERS = any member of the owning workspace; ADMINS and OWNER = its
 * admins (a shared agent has no single owner, so OWNER means those who manage it).
 */
export async function canInvokeAgent(prisma: AgentDb, actor: { userId: string | null | undefined }, agent: Pick<AgentRecord, "status" | "ownerUserId" | "ownerType" | "ownerWorkspaceId" | "invokePolicy">): Promise<boolean> {
  if (!actor.userId || agent.status !== "ACTIVE") return false
  const owner = agentOwner(agent)
  if (!owner) return false
  if (owner.type === "USER") return owner.userId === actor.userId
  if (agentInvokePolicy(agent) === "WORKSPACE_MEMBERS") return isWorkspaceMemberUser(prisma, actor.userId, owner.workspaceId)
  return isWorkspaceAdminUser(prisma, actor.userId, owner.workspaceId)
}
