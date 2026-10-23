/**
 * Self-service account deletion.
 *
 * ## Decisions (what is deleted, what is kept, and why)
 *
 * DELETED, because it is the person's own data or a credential that acts as them:
 *   - Auth: sessions, Google sign-in `accounts` rows (their stored OAuth tokens), passkeys, pending sign-in-email tokens.
 *   - Drive and other connector tokens (`mcp_connector_grants`): revoked at the provider first, best effort, then deleted.
 *   - API keys, OAuth tokens/consents/authorization codes, widget visitor sessions, personal agents and their grants.
 *   - Memberships (organization and workspace), follows, notifications, update read-markers, personal saved roadmap views.
 *   - Agent conversations the user owns, including every message, run trace (events), session transcript,
 *     participant row and audit row. Also the user's own exchanges (messages they authored, runs they started)
 *     inside conversations other people own.
 *
 * KEPT, but no longer attributable to the person: content authored into a shared workspace (OKRs, opportunities,
 * solutions, docs, tasks, research, roadmap items, decisions, uploads). That content belongs to the workspace and
 * to the teammates who work in it, so deleting it would damage other people's records. The `created_by_id` style
 * columns are left pointing at a user row that no longer exists. The app already tolerates that (readers fall back
 * to a stored name or a "Former member" label), and no join in the schema is enforced because there are no foreign
 * keys on either backend (`relationMode = "prisma"`). The denormalized display name on comments, doc comments and
 * doc versions is rewritten to "Deleted user", and task assignments are cleared.
 *
 * KNOWN LIMITS (also stated in the privacy policy): names typed as free text (solution comments, task owner names,
 * @mentions in prose) are not rewritten; decision records keep their actor id as an audit trail; other people's
 * copies of anything shared with them are theirs.
 *
 * ## Workspaces and organizations the user owns
 *
 * Deletion never silently orphans or deletes a team's data, and "only member" is not the same as "nobody else can
 * reach it": org OWNER/ADMINs can administer every workspace in their org (resolveWorkspaceAdmin) and, with
 * org-wide read access, any org member can read it.
 *   - An ORGANIZATION that no one else belongs to (no other org member, no other member of any of its workspaces) is
 *     unreachable afterward, so it is deleted with the account, but only when the caller names it explicitly
 *     (`soleOwnedOrganizationIds`, which must equal the set recomputed at delete time). Without that the request is
 *     refused and the exact list is returned so the UI can show it.
 *   - A WORKSPACE inside an organization other people belong to is NEVER deleted here, even if the user is its only
 *     member: the user's membership is dropped and the workspace stays with the people who can still reach it.
 *   - BLOCKED instead, when dropping the user would leave a workspace others can reach with no administrator at all
 *     (counting other workspace admins and other org OWNER/ADMINs), or leave an organization others belong to with
 *     no OWNER. The user must promote someone first.
 *
 * ## Ordering and failure
 *
 * The work cannot be one transaction (DSQL caps rows per transaction), so it is a sequence of bounded, idempotent
 * steps. Credentials and the user row go LAST: a failure part-way leaves the user signed in and able to retry, and a
 * retry finishes the job. The provider revocation runs FIRST, while the tokens still exist to be named.
 */
import type { AppPrismaClient } from "@/lib/db"
import { deleteInBatches, updateInBatches } from "@/lib/batched-delete"
import { deleteRunsWhere, deleteWebSearchesWhere, purgeConversations, tolerateMissingTable } from "@/lib/agent-conversation-purge"
import { deleteWorkspaceCascade } from "@/lib/delete-workspace-cascade"
import { revokeAllConnectorGrants } from "@/lib/mcp-connectors/revoke-all"
import { isOrgAdminRole, normalizeOrgRole, normalizeWorkspaceRole } from "@/lib/roles"

export const DELETED_USER_LABEL = "Deleted user"

/** A failure whose message is safe and useful to show the user ("try again"), unlike an arbitrary internal error. */
export class RetryableDeletionError extends Error {}

export type DeletionBlocker =
  | { kind: "ORGANIZATION_SOLE_OWNER"; organization: { slug: string; name: string }; otherMembers: number }
  | { kind: "WORKSPACE_SOLE_ADMIN"; workspace: { slug: string; name: string; orgSlug: string }; otherMembers: number }

export interface DeletionPlan {
  blockers: DeletionBlocker[]
  /** Organizations nobody else can reach; deleted with the account when the caller names them. */
  soleOwned: {
    organizations: { id: string; slug: string; name: string; workspaceNames: string[] }[]
  }
}

export async function planAccountDeletion(prisma: AppPrismaClient, userId: string): Promise<DeletionPlan> {
  const plan: DeletionPlan = { blockers: [], soleOwned: { organizations: [] } }

  // ── Organizations ──────────────────────────────────────────────────────────
  const orgMemberships = await prisma.organizationMember.findMany({ where: { userId }, select: { organizationId: true, role: true } })
  const orgIds = orgMemberships.map((m) => m.organizationId)
  const orgs = orgIds.length ? await prisma.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, slug: true, name: true } }) : []
  const orgMembers = orgIds.length ? await prisma.organizationMember.findMany({ where: { organizationId: { in: orgIds } }, select: { organizationId: true, userId: true, role: true } }) : []
  const orgWorkspaces = orgIds.length ? await prisma.workspace.findMany({ where: { organizationId: { in: orgIds } }, select: { id: true, slug: true, name: true, organizationId: true } }) : []
  const orgWorkspaceIds = orgWorkspaces.map((w) => w.id)
  const workspaceMembersInOrgs = orgWorkspaceIds.length ? await prisma.workspaceMember.findMany({ where: { workspaceId: { in: orgWorkspaceIds } }, select: { workspaceId: true, userId: true } }) : []

  const soloOrgIds = new Set<string>()
  for (const membership of orgMemberships) {
    const org = orgs.find((o) => o.id === membership.organizationId)
    if (!org) continue
    const others = orgMembers.filter((m) => m.organizationId === org.id && m.userId !== userId)
    const workspaces = orgWorkspaces.filter((w) => w.organizationId === org.id)
    const workspaceIds = new Set(workspaces.map((w) => w.id))
    const otherWorkspaceUsers = new Set(workspaceMembersInOrgs.filter((m) => workspaceIds.has(m.workspaceId) && m.userId !== userId).map((m) => m.userId))
    if (others.length === 0 && otherWorkspaceUsers.size === 0) {
      soloOrgIds.add(org.id)
      plan.soleOwned.organizations.push({ id: org.id, slug: org.slug, name: org.name, workspaceNames: workspaces.map((w) => w.name) })
      continue
    }
    const othersOwners = others.filter((m) => normalizeOrgRole(m.role) === "OWNER").length
    if (normalizeOrgRole(membership.role) === "OWNER" && othersOwners === 0) {
      plan.blockers.push({
        kind: "ORGANIZATION_SOLE_OWNER",
        organization: { slug: org.slug, name: org.name },
        otherMembers: new Set([...others.map((m) => m.userId), ...otherWorkspaceUsers]).size,
      })
    }
  }

  // ── Workspaces (those not already covered by a sole-member organization) ───
  const workspaceMemberships = await prisma.workspaceMember.findMany({ where: { userId }, select: { workspaceId: true, role: true } })
  const workspaceIds = workspaceMemberships.map((m) => m.workspaceId)
  const workspaces = workspaceIds.length ? await prisma.workspace.findMany({ where: { id: { in: workspaceIds } }, select: { id: true, slug: true, name: true, organizationId: true } }) : []
  const workspaceMembers = workspaceIds.length ? await prisma.workspaceMember.findMany({ where: { workspaceId: { in: workspaceIds } }, select: { workspaceId: true, userId: true, role: true } }) : []
  const workspaceOrgIds = [...new Set(workspaces.map((w) => w.organizationId))]
  const workspaceOrgs = workspaceOrgIds.length ? await prisma.organization.findMany({ where: { id: { in: workspaceOrgIds } }, select: { id: true, slug: true } }) : []
  const workspaceOrgMembers = workspaceOrgIds.length ? await prisma.organizationMember.findMany({ where: { organizationId: { in: workspaceOrgIds } }, select: { organizationId: true, userId: true, role: true } }) : []
  for (const membership of workspaceMemberships) {
    const workspace = workspaces.find((w) => w.id === membership.workspaceId)
    if (!workspace || soloOrgIds.has(workspace.organizationId)) continue
    const orgSlug = workspaceOrgs.find((o) => o.id === workspace.organizationId)?.slug ?? ""
    const others = workspaceMembers.filter((m) => m.workspaceId === workspace.id && m.userId !== userId)
    const otherOrgMembers = workspaceOrgMembers.filter((m) => m.organizationId === workspace.organizationId && m.userId !== userId)
    // Everyone who can still reach this workspace once the user is gone.
    const reachable = new Set([...others.map((m) => m.userId), ...otherOrgMembers.map((m) => m.userId)])
    if (reachable.size === 0) continue
    // Everyone who can still administer it: other workspace admins and other org OWNER/ADMINs.
    const admins = new Set([
      ...others.filter((m) => normalizeWorkspaceRole(m.role) === "ADMIN").map((m) => m.userId),
      ...otherOrgMembers.filter((m) => isOrgAdminRole(m.role)).map((m) => m.userId),
    ])
    const userAdministers = normalizeWorkspaceRole(membership.role) === "ADMIN" || others.length === 0
    if (userAdministers && admins.size === 0) {
      plan.blockers.push({ kind: "WORKSPACE_SOLE_ADMIN", workspace: { slug: workspace.slug, name: workspace.name, orgSlug }, otherMembers: reachable.size })
    }
  }
  return plan
}

export interface AccountDeletionOptions {
  /** Ids of the sole-owned organizations the user confirmed. Must equal the set recomputed at delete time. */
  soleOwnedOrganizationIds?: string[]
  /** Test seam; defaults to global fetch. */
  fetchImpl?: typeof fetch
}

export type AccountDeletionResult =
  | { ok: true; revocation: RevocationSummary }
  | { ok: false; reason: "NOT_FOUND" }
  | { ok: false; reason: "BLOCKED"; plan: DeletionPlan }
  | { ok: false; reason: "SOLE_OWNED_NEEDS_CONFIRMATION" | "SOLE_OWNED_CHANGED"; plan: DeletionPlan }

export interface RevocationSummary {
  /** Google sign-in tokens Google accepted the revocation of (best effort). */
  googleSignInRevoked: number
  googleSignInNotConfirmed: number
  /** Connector (Google Drive, v0, ...) grants wiped locally. */
  connectorGrantsWiped: number
  connectorProviderRevoked: number
  connectorProviderNotConfirmed: number
}

const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke"

/** RFC 7009 revocation. Never throws: a provider outage must not stop a deletion the user asked for. */
async function revokeGoogleToken(token: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(5_000),
    })
    return response.ok
  } catch {
    return false
  }
}

async function revokeProviderAccess(prisma: AppPrismaClient, userId: string, fetchImpl: typeof fetch): Promise<RevocationSummary> {
  const summary: RevocationSummary = { googleSignInRevoked: 0, googleSignInNotConfirmed: 0, connectorGrantsWiped: 0, connectorProviderRevoked: 0, connectorProviderNotConfirmed: 0 }

  const accounts = await prisma.account.findMany({ where: { userId, provider: "google" }, select: { refresh_token: true, access_token: true } })
  for (const account of accounts) {
    // A refresh token is preferred: revoking it also invalidates access tokens issued from it.
    const token = account.refresh_token ?? account.access_token
    if (!token) continue
    if (await revokeGoogleToken(token, fetchImpl)) summary.googleSignInRevoked++
    else summary.googleSignInNotConfirmed++
  }

  try {
    const connectors = await revokeAllConnectorGrants({ userId, dryRun: false })
    summary.connectorGrantsWiped = connectors.wiped
    summary.connectorProviderRevoked = connectors.providerRevoked
    summary.connectorProviderNotConfirmed = connectors.providerNotConfirmed + connectors.undecryptable
  } catch (error) {
    // The grant rows are deleted below whatever happens here; the local copy of the token is what matters most.
    console.error("[account-deletion] connector revocation failed", error)
  }
  return summary
}

async function deleteOwnedConversations(prisma: AppPrismaClient, userId: string): Promise<void> {
  for (;;) {
    const owned = await prisma.agentConversation.findMany({ where: { userId }, select: { id: true }, take: 100 })
    if (owned.length === 0) return
    const { purged, kept } = await purgeConversations(prisma, owned.map((c) => c.id))
    if (kept.length > 0) {
      // A transcript object could not be deleted. Refuse to report success: the user can retry, and the
      // pointer row that names the object is still there for that retry.
      throw new RetryableDeletionError("Stored agent transcripts could not be removed yet. Please try again in a few minutes.")
    }
    if (purged.length === 0) return
  }
}

async function deleteSoleOwned(prisma: AppPrismaClient, plan: DeletionPlan): Promise<void> {
  for (const org of plan.soleOwned.organizations) {
    const workspaces = await prisma.workspace.findMany({ where: { organizationId: org.id }, select: { id: true } })
    for (const workspace of workspaces) {
      await deleteWorkspaceCascade(prisma, workspace.id)
    }
    // Same tail as deleteOrganization in app/[orgSlug]/settings/actions.ts: org-level rows have no FK cascade.
    const scoringModelIds = (await prisma.scoringModel.findMany({ where: { organizationId: org.id }, select: { id: true } })).map((m) => m.id)
    if (scoringModelIds.length) await prisma.scoringModelMetric.deleteMany({ where: { scoringModelId: { in: scoringModelIds } } })
    await prisma.scoringModel.deleteMany({ where: { organizationId: org.id } })
    await prisma.savedView.deleteMany({ where: { organizationId: org.id } })
    await prisma.organizationMember.deleteMany({ where: { organizationId: org.id } })
    await prisma.organization.deleteMany({ where: { id: org.id } })
  }
}

/**
 * Deletes the account. Callers must already have authenticated the user and checked the typed confirmation;
 * this function trusts `userId` and enforces only the data rules (blockers, sole-owned opt-in).
 */
export async function deleteAccount(prisma: AppPrismaClient, userId: string, options: AccountDeletionOptions = {}): Promise<AccountDeletionResult> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } })
  if (!user) return { ok: false, reason: "NOT_FOUND" }

  const plan = await planAccountDeletion(prisma, userId)
  if (plan.blockers.length > 0) return { ok: false, reason: "BLOCKED", plan }
  const hasSoleOwned = plan.soleOwned.organizations.length > 0
  const confirmed = new Set(options.soleOwnedOrganizationIds ?? [])
  const planned = new Set(plan.soleOwned.organizations.map((org) => org.id))
  if (confirmed.size === 0 && hasSoleOwned) return { ok: false, reason: "SOLE_OWNED_NEEDS_CONFIRMATION", plan }
  // What the user confirmed on screen must be exactly what would be deleted now: membership can change in between.
  if (confirmed.size !== planned.size || [...confirmed].some((id) => !planned.has(id))) return { ok: false, reason: "SOLE_OWNED_CHANGED", plan }

  // 1. Tell providers first, while the tokens still exist to be named.
  const revocation = await revokeProviderAccess(prisma, userId, options.fetchImpl ?? fetch)

  // 2. Resources only this user belongs to (opt-in, checked above).
  if (hasSoleOwned) await deleteSoleOwned(prisma, plan)

  // 3. Agent data: owned conversations in full, then the user's own exchanges inside other people's conversations.
  await deleteOwnedConversations(prisma, userId)
  await deleteRunsWhere(prisma, { userId })
  await deleteInBatches(prisma.agentMessage, { authorUserId: userId })
  await tolerateMissingTable(() => deleteInBatches(prisma.agentConversationParticipant, { userId }), 0)
  await tolerateMissingTable(() => deleteInBatches(prisma.agentConversationReview, { userId }), 0)
  await deleteInBatches(prisma.agentAuditLog, { userId })
  await deleteInBatches(prisma.agentToolCall, { userId })
  await deleteWebSearchesWhere(prisma, { userId })
  const personalAgents = (await prisma.agent.findMany({ where: { ownerUserId: userId }, select: { id: true } })).map((a) => a.id)
  if (personalAgents.length) {
    await prisma.agentWorkspaceGrant.deleteMany({ where: { agentId: { in: personalAgents } } })
    await prisma.agentOrgAdminGrant.deleteMany({ where: { agentId: { in: personalAgents } } })
    await deleteInBatches(prisma.agentToolCall, { agentId: { in: personalAgents } })
    await prisma.agent.deleteMany({ where: { id: { in: personalAgents } } })
  }

  // 4. Credentials and per-user state.
  await deleteInBatches(prisma.apiKey, { userId })
  await tolerateMissingTable(async () => {
    await deleteInBatches(prisma.oAuthToken, { userId })
    if (personalAgents.length) await deleteInBatches(prisma.oAuthToken, { agentId: { in: personalAgents } })
    await deleteInBatches(prisma.oAuthConsent, { userId })
    await deleteInBatches(prisma.oAuthAuthorizationCode, { userId })
    await deleteInBatches(prisma.oAuthAuthorizationEvent, { userId })
  }, undefined)
  await tolerateMissingTable(async () => {
    await prisma.mcpConnectorGrant.deleteMany({ where: { userId } })
    await prisma.mcpConnectorAuthRequest.deleteMany({ where: { userId } })
  }, undefined)
  await tolerateMissingTable(async () => {
    await prisma.embedVisitorSession.deleteMany({ where: { userId } })
    await prisma.embedAuthHandoff.deleteMany({ where: { userId } })
  }, undefined)
  await tolerateMissingTable(async () => {
    await deleteInBatches(prisma.follow, { userId })
    await deleteInBatches(prisma.notification, { recipientUserId: userId })
  }, undefined)
  await tolerateMissingTable(() => prisma.workspaceUpdatesReadState.deleteMany({ where: { userId } }), { count: 0 })
  await tolerateMissingTable(() => prisma.savedView.deleteMany({ where: { ownerId: userId, visibility: "PERSONAL" } }), { count: 0 })

  // 5. Attribution: shared content stays, the person goes.
  await updateInBatches(prisma.comment, { authorId: userId, authorType: "HUMAN", authorName: { not: DELETED_USER_LABEL } }, { authorName: DELETED_USER_LABEL })
  await updateInBatches(prisma.docComment, { authorId: userId, authorType: "HUMAN", authorName: { not: DELETED_USER_LABEL } }, { authorName: DELETED_USER_LABEL })
  await updateInBatches(prisma.docVersion, { createdById: userId, OR: [{ createdByName: null }, { createdByName: { not: DELETED_USER_LABEL } }] }, { createdByName: DELETED_USER_LABEL })
  await updateInBatches(prisma.task, { assigneeUserId: userId }, { assigneeUserId: null })

  // 6. Memberships.
  await prisma.workspaceMember.deleteMany({ where: { userId } })
  await prisma.organizationMember.deleteMany({ where: { userId } })

  // 7. Sign-in material, then the user. Last on purpose: see "Ordering and failure" above.
  await prisma.session.deleteMany({ where: { userId } })
  await prisma.authenticator.deleteMany({ where: { userId } })
  await prisma.verificationToken.deleteMany({ where: { identifier: user.email } })
  await prisma.account.deleteMany({ where: { userId } })
  await prisma.user.deleteMany({ where: { id: userId } })

  return { ok: true, revocation }
}
