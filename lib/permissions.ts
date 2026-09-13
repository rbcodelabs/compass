/**
 * Role-gated authorization helpers for UI server actions.
 *
 * `OrgRole`/`WorkspaceRole` have existed in lib/types.ts since the initial
 * schema, but nothing in the app checked them for authorization until this
 * module — every prior "settings" action only checked *membership*
 * (resolveWorkspace in app/[orgSlug]/[workspaceSlug]/settings/actions.ts),
 * not role. These two helpers add the first real role gates, following the
 * exact same throw-string convention as resolveWorkspace so existing test
 * patterns (`.rejects.toThrow("...")`) apply unchanged.
 *
 * MCP tool handlers intentionally do NOT use these — see
 * lib/scoring-tool-handlers.ts for why (API-key auth only, matching every
 * other existing MCP tool).
 */

import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { isOrgAdminRole, normalizeWorkspaceRole } from "@/lib/roles"

/**
 * Marker subclass for the *expected* authorization outcomes below (not signed
 * in / not a member / insufficient role).
 *
 * Server actions need to tell these apart from a genuine fault (a dropped
 * database connection inside the same lookup) so they can return the former to
 * the caller as a value and let the latter keep throwing. Matching on
 * `error.message` would work today but breaks the moment a message is reworded,
 * so the distinction is carried by the type instead.
 *
 * The messages are unchanged, so existing `.rejects.toThrow("Unauthorized")`
 * assertions — and every non-action caller that relies on these throwing —
 * behave exactly as before.
 */
export class PermissionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PermissionError"
  }
}

export function isPermissionError(error: unknown): error is PermissionError {
  return error instanceof PermissionError
}

/**
 * Resolves the caller's organization admin membership by org slug.
 * Throws "Unauthorized" if not signed in, "Organization not found" if the
 * org doesn't exist or the caller isn't a member, and
 * "Forbidden: organization admin required" if the caller is a member but
 * not an OWNER or ADMIN. The stored role is normalized before comparison.
 */
export async function resolveOrgAdmin(orgSlug: string) {
  const session = await auth()
  if (!session?.user?.id) throw new PermissionError("Unauthorized")

  const prisma = getPrisma()
  const member = await prisma.organizationMember.findFirst({
    where: {
      organization: { slug: orgSlug },
      userId: session.user.id,
    },
    select: { role: true, organizationId: true },
  })

  if (!member) throw new PermissionError("Organization not found")
  // Normalized rather than matched exactly, for the same reason as
  // resolveWorkspaceAdmin: the column is a bare VarChar and has held
  // lowercase values. One definition of org admin lives in lib/roles.ts.
  if (!isOrgAdminRole(member.role)) {
    throw new PermissionError("Forbidden: organization admin required")
  }

  return { prisma, organizationId: member.organizationId }
}

/**
 * Resolves the caller's workspace admin membership by org/workspace slug.
 * Same shape as resolveWorkspace (settings/actions.ts) plus a role check.
 * Throws "Unauthorized" if not signed in, "Workspace not found" if the
 * workspace does not exist or the caller is not a member, and
 * "Forbidden: workspace admin required" if the caller is a member but is
 * neither a workspace admin nor an admin of the owning organization.
 *
 * The stored workspace role is normalized before comparison. The column is a
 * bare VarChar with no DB enum, and several writers historically put values
 * outside WorkspaceRole into it (OWNER from the MCP create_workspace tool, a
 * lowercase owner from the provisioning endpoint). The previous strict
 * inequality against ADMIN denied exactly the people who had created the
 * workspace. See lib/roles.ts.
 *
 * An org OWNER/ADMIN also passes, in every workspace in their org, so an org
 * admin can never be locked out of a workspace their organization owns. The
 * org membership is selected in the same query as the workspace membership
 * to avoid a second round trip.
 */
export async function resolveWorkspaceAdmin(orgSlug: string, workspaceSlug: string) {
  const session = await auth()
  if (!session?.user?.id) throw new PermissionError("Unauthorized")

  const prisma = getPrisma()
  const workspace = await prisma.workspace.findFirst({
    where: {
      slug: workspaceSlug,
      organization: { slug: orgSlug },
      members: { some: { userId: session.user.id } },
    },
    select: {
      id: true,
      organizationId: true,
      members: {
        where: { userId: session.user.id },
        select: { role: true },
      },
      organization: {
        select: {
          members: {
            where: { userId: session.user.id },
            select: { role: true },
          },
        },
      },
    },
  })

  if (!workspace) throw new PermissionError("Workspace not found")

  const isWorkspaceAdmin = normalizeWorkspaceRole(workspace.members[0]?.role) === "ADMIN"
  // Optional chaining on a non-nullable relation is deliberate: it keeps a
  // partially-selected or mocked workspace object from throwing here.
  const isOrgAdmin = isOrgAdminRole(workspace.organization?.members[0]?.role)
  if (!isWorkspaceAdmin && !isOrgAdmin) {
    throw new PermissionError("Forbidden: workspace admin required")
  }

  return { prisma, workspaceId: workspace.id, organizationId: workspace.organizationId }
}
