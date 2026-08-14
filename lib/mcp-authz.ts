/**
 * Per-user authorization for MCP tool handlers.
 *
 * BACKGROUND. Historically every MCP tool trusted any valid bearer token
 * (see the old note in lib/permissions.ts): `validateMcpAuth` returns the
 * caller's `userId`, but `withMcpAuth` discarded it and no handler applied a
 * membership/role gate — so any key could read/write any org's data. This
 * module closes that hole for per-user keys while preserving the shared
 * service-account key's global access.
 *
 * MODEL.
 *   - The acting identity is an `McpActor = { userId: string | null }`.
 *   - `userId === null`  → the shared service key (MCP_API_KEY). Trusted,
 *     GLOBAL access — every assert here is a no-op for it. Existing
 *     server-to-server automations depend on this and must keep working.
 *   - `userId !== null`  → a per-user `cmp_…` ApiKey. Scoped to the
 *     workspaces/orgs that user is a member of, mirroring the session-based
 *     gates in lib/permissions.ts (`resolveWorkspace*`/`resolveOrg*`).
 *
 * PLUMBING. The actor is carried per-request via AsyncLocalStorage: the route
 * wraps `_handler(req)` in `runWithMcpActor(actor, …)` and handlers read it
 * with `getMcpActor()`. (Verified: ALS propagates through mcp-handler's
 * stateless dispatch into tool callbacks.)
 *
 * FAIL-CLOSED. Every assert THROWS `McpAuthzError` on denial. mcp-handler
 * turns a thrown error into a clean `isError` tool result (message preserved,
 * HTTP 200) — so a denial surfaces to the agent as an error, and a handler
 * that forgets to branch on a return value cannot accidentally fail open.
 * Denials use a single "not found or access denied" phrasing so a non-member
 * cannot distinguish "doesn't exist" from "not yours" (no existence leak),
 * matching resolveWorkspace's behavior.
 */

import { AsyncLocalStorage } from "node:async_hooks"
import getPrisma from "@/lib/db"

export type McpActor = { userId: string | null }

export class McpAuthzError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "McpAuthzError"
  }
}

const actorStore = new AsyncLocalStorage<McpActor>()

/** Establish the acting identity for the duration of `fn` (route + tests). */
export function runWithMcpActor<T>(actor: McpActor, fn: () => T): T {
  return actorStore.run(actor, fn)
}

/**
 * Read the ambient acting identity. Throws if called outside a
 * `runWithMcpActor` scope — a fail-closed guard against a handler being
 * invoked without the auth boundary having run.
 */
export function getMcpActor(): McpActor {
  const actor = actorStore.getStore()
  if (!actor) {
    throw new McpAuthzError("Authorization context is missing for this request.")
  }
  return actor
}

const isService = (actor: McpActor): boolean => actor.userId === null

/**
 * True for the shared service key (global/trusted). List tools that scope
 * their results by the caller's memberships use this to skip the membership
 * filter for the service key.
 */
export function isServiceActor(actor: McpActor): boolean {
  return isService(actor)
}

// ──────────────────────────────────────────────────────────────────────────
// Workspace-scoped (pattern b): tools that take a workspaceId directly.
// ──────────────────────────────────────────────────────────────────────────

/** Assert the actor may act within `workspaceId` (any member). */
export async function assertWorkspaceMember(actor: McpActor, workspaceId: string): Promise<void> {
  if (isService(actor)) return
  const prisma = getPrisma()
  const ws = await prisma.workspace.findFirst({
    where: { id: workspaceId, members: { some: { userId: actor.userId! } } },
    select: { id: true },
  })
  if (!ws) {
    throw new McpAuthzError(`Workspace not found or access denied: ${workspaceId}`)
  }
}

/** Assert the actor is a workspace ADMIN of `workspaceId`. */
export async function assertWorkspaceAdmin(actor: McpActor, workspaceId: string): Promise<void> {
  if (isService(actor)) return
  const prisma = getPrisma()
  const member = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId: actor.userId! },
    select: { role: true },
  })
  if (!member) {
    throw new McpAuthzError(`Workspace not found or access denied: ${workspaceId}`)
  }
  if (member.role !== "ADMIN") {
    throw new McpAuthzError("Forbidden: workspace admin required.")
  }
}

/**
 * Assert the actor may access the workspace identified by org slug +
 * workspace slug (used by get_workspace_by_slug). Returns the resolved id.
 */
export async function assertWorkspaceBySlug(
  actor: McpActor,
  orgSlug: string,
  workspaceSlug: string
): Promise<{ workspaceId: string }> {
  const prisma = getPrisma()
  const ws = await prisma.workspace.findFirst({
    where: {
      slug: workspaceSlug,
      organization: { slug: orgSlug },
      ...(isService(actor) ? {} : { members: { some: { userId: actor.userId! } } }),
    },
    select: { id: true },
  })
  if (!ws) {
    throw new McpAuthzError(`Workspace not found or access denied: ${orgSlug}/${workspaceSlug}`)
  }
  return { workspaceId: ws.id }
}

// ──────────────────────────────────────────────────────────────────────────
// Org-scoped (pattern a): tools that take an orgSlug.
// ──────────────────────────────────────────────────────────────────────────

/** Assert the actor is a member of the org identified by `orgSlug`. */
export async function assertOrgMemberBySlug(
  actor: McpActor,
  orgSlug: string
): Promise<{ organizationId: string }> {
  const prisma = getPrisma()
  if (isService(actor)) {
    const org = await prisma.organization.findUnique({ where: { slug: orgSlug }, select: { id: true } })
    if (!org) throw new McpAuthzError(`Organization not found: ${orgSlug}`)
    return { organizationId: org.id }
  }
  const member = await prisma.organizationMember.findFirst({
    where: { userId: actor.userId!, organization: { slug: orgSlug } },
    select: { organizationId: true },
  })
  if (!member) {
    throw new McpAuthzError(`Organization not found or access denied: ${orgSlug}`)
  }
  return { organizationId: member.organizationId }
}

/** Assert the actor is an OWNER/ADMIN of the org identified by `orgSlug`. */
export async function assertOrgAdminBySlug(
  actor: McpActor,
  orgSlug: string
): Promise<{ organizationId: string }> {
  const prisma = getPrisma()
  if (isService(actor)) {
    const org = await prisma.organization.findUnique({ where: { slug: orgSlug }, select: { id: true } })
    if (!org) throw new McpAuthzError(`Organization not found: ${orgSlug}`)
    return { organizationId: org.id }
  }
  const member = await prisma.organizationMember.findFirst({
    where: { userId: actor.userId!, organization: { slug: orgSlug } },
    select: { organizationId: true, role: true },
  })
  if (!member) {
    throw new McpAuthzError(`Organization not found or access denied: ${orgSlug}`)
  }
  if (member.role !== "OWNER" && member.role !== "ADMIN") {
    throw new McpAuthzError("Forbidden: organization admin required.")
  }
  return { organizationId: member.organizationId }
}

// ──────────────────────────────────────────────────────────────────────────
// Child-entity-scoped (pattern c): tools that take a leaf entity id which
// belongs (directly or transitively) to a workspace. Each resolver returns
// the owning workspaceId, or null if the entity does not exist.
// ──────────────────────────────────────────────────────────────────────────

export type WorkspaceEntityType =
  | "opportunity"
  | "solution"
  | "assumption"
  | "solutionComment"
  | "okrCycle"
  | "objective"
  | "keyResult"
  | "experiment"
  | "roadmapItem"
  | "launchChecklist"
  | "launchChecklistItem"
  | "squad"
  | "task"
  | "feedbackItem"
  | "doc"
  | "docVersion"
  | "docComment"
  | "evidence"
  | "opportunityScore"
  | "workspaceScoringConfig"

// Each resolver walks the FK chain to the owning workspaceId in one query.
// Relation/field names verified against prisma/schema.prisma.
const WORKSPACE_ENTITY_RESOLVERS: Record<
  WorkspaceEntityType,
  (prisma: ReturnType<typeof getPrisma>, id: string) => Promise<string | null>
> = {
  opportunity: async (p, id) =>
    (await p.opportunity.findUnique({ where: { id }, select: { workspaceId: true } }))?.workspaceId ?? null,
  solution: async (p, id) =>
    (await p.solution.findUnique({ where: { id }, select: { opportunity: { select: { workspaceId: true } } } }))
      ?.opportunity?.workspaceId ?? null,
  assumption: async (p, id) =>
    (await p.assumption.findUnique({
      where: { id },
      select: { solution: { select: { opportunity: { select: { workspaceId: true } } } } },
    }))?.solution?.opportunity?.workspaceId ?? null,
  solutionComment: async (p, id) =>
    (await p.solutionComment.findUnique({
      where: { id },
      select: { solution: { select: { opportunity: { select: { workspaceId: true } } } } },
    }))?.solution?.opportunity?.workspaceId ?? null,
  okrCycle: async (p, id) =>
    (await p.oKRCycle.findUnique({ where: { id }, select: { workspaceId: true } }))?.workspaceId ?? null,
  objective: async (p, id) =>
    (await p.objective.findUnique({ where: { id }, select: { cycle: { select: { workspaceId: true } } } }))
      ?.cycle?.workspaceId ?? null,
  keyResult: async (p, id) =>
    (await p.keyResult.findUnique({
      where: { id },
      select: { objective: { select: { cycle: { select: { workspaceId: true } } } } },
    }))?.objective?.cycle?.workspaceId ?? null,
  experiment: async (p, id) =>
    (await p.experiment.findUnique({ where: { id }, select: { workspaceId: true } }))?.workspaceId ?? null,
  roadmapItem: async (p, id) =>
    (await p.roadmapItem.findUnique({ where: { id }, select: { workspaceId: true } }))?.workspaceId ?? null,
  launchChecklist: async (p, id) =>
    (await p.launchChecklist.findUnique({ where: { id }, select: { roadmapItem: { select: { workspaceId: true } } } }))
      ?.roadmapItem?.workspaceId ?? null,
  launchChecklistItem: async (p, id) =>
    (await p.launchChecklistItem.findUnique({
      where: { id },
      select: { launchChecklist: { select: { roadmapItem: { select: { workspaceId: true } } } } },
    }))?.launchChecklist?.roadmapItem?.workspaceId ?? null,
  squad: async (p, id) =>
    (await p.squad.findUnique({ where: { id }, select: { workspaceId: true } }))?.workspaceId ?? null,
  task: async (p, id) =>
    (await p.task.findUnique({ where: { id }, select: { workspaceId: true } }))?.workspaceId ?? null,
  feedbackItem: async (p, id) =>
    (await p.feedbackItem.findUnique({ where: { id }, select: { workspaceId: true } }))?.workspaceId ?? null,
  doc: async (p, id) =>
    (await p.doc.findUnique({ where: { id }, select: { workspaceId: true } }))?.workspaceId ?? null,
  docVersion: async (p, id) =>
    (await p.docVersion.findUnique({ where: { id }, select: { doc: { select: { workspaceId: true } } } }))
      ?.doc?.workspaceId ?? null,
  docComment: async (p, id) =>
    (await p.docComment.findUnique({ where: { id }, select: { doc: { select: { workspaceId: true } } } }))
      ?.doc?.workspaceId ?? null,
  evidence: async (p, id) =>
    (await p.evidence.findUnique({ where: { id }, select: { workspaceId: true } }))?.workspaceId ?? null,
  opportunityScore: async (p, id) =>
    (await p.opportunityScore.findUnique({ where: { id }, select: { opportunity: { select: { workspaceId: true } } } }))
      ?.opportunity?.workspaceId ?? null,
  workspaceScoringConfig: async (p, id) =>
    (await p.workspaceScoringConfig.findUnique({ where: { id }, select: { workspaceId: true } }))?.workspaceId ?? null,
}

/**
 * Assert the actor may act on a child entity, identified by its id. Resolves
 * the entity's owning workspace and checks membership. Returns the resolved
 * `workspaceId` for the handler to reuse. A missing entity and a
 * non-member are reported identically (no existence leak).
 */
export async function assertEntityAccess(
  actor: McpActor,
  entityType: WorkspaceEntityType,
  entityId: string
): Promise<{ workspaceId: string }> {
  const prisma = getPrisma()
  const workspaceId = await WORKSPACE_ENTITY_RESOLVERS[entityType](prisma, entityId)
  if (workspaceId === null) {
    throw new McpAuthzError(`${entityType} not found or access denied: ${entityId}`)
  }
  if (!isService(actor)) {
    const ws = await prisma.workspace.findFirst({
      where: { id: workspaceId, members: { some: { userId: actor.userId! } } },
      select: { id: true },
    })
    if (!ws) {
      throw new McpAuthzError(`${entityType} not found or access denied: ${entityId}`)
    }
  }
  return { workspaceId }
}

// ──────────────────────────────────────────────────────────────────────────
// Org-scoped child (scoring models): tools that take a scoringModelId, which
// belongs to an organization (not a workspace).
// ──────────────────────────────────────────────────────────────────────────

/**
 * Assert the actor may act on an org-level scoring model by id. `admin: true`
 * requires org OWNER/ADMIN (create/update/archive); otherwise any org member
 * (read). Returns the owning `organizationId`.
 */
export async function assertScoringModelAccess(
  actor: McpActor,
  scoringModelId: string,
  opts: { admin?: boolean } = {}
): Promise<{ organizationId: string }> {
  const prisma = getPrisma()
  const model = await prisma.scoringModel.findUnique({
    where: { id: scoringModelId },
    select: { organizationId: true },
  })
  if (!model) {
    throw new McpAuthzError(`Scoring model not found or access denied: ${scoringModelId}`)
  }
  if (isService(actor)) return { organizationId: model.organizationId }

  const member = await prisma.organizationMember.findFirst({
    where: { organizationId: model.organizationId, userId: actor.userId! },
    select: { role: true },
  })
  if (!member) {
    throw new McpAuthzError(`Scoring model not found or access denied: ${scoringModelId}`)
  }
  if (opts.admin && member.role !== "OWNER" && member.role !== "ADMIN") {
    throw new McpAuthzError("Forbidden: organization admin required.")
  }
  return { organizationId: model.organizationId }
}
