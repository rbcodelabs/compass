import { cache } from "react"
import { notFound, redirect } from "next/navigation"
import type { Organization, Prisma, Workspace } from "@prisma/client"
import getPrisma from "@/lib/db"
import { PermissionError } from "@/lib/permissions"
import { isOrgAdminRole } from "@/lib/roles"
import { getSessionUser, type SessionUser } from "@/lib/session"
import type { WorkspaceBrandingFields } from "@/lib/branding"

export type UserWorkspace = {
  id: string
  name: string
  slug: string
  orgSlug: string
  orgName: string
}

/**
 * The columns the shared workspace resolver hydrates.
 *
 * Deliberately excludes every `sso*` column. `ssoSecretEncrypted` is
 * reversible ciphertext, and the object this select produces is handed to
 * every layout and page in the workspace tree; secret material should not ride
 * along for the trip. The two callers that genuinely need it (the settings
 * page and the portal SSO route) read it explicitly with their own query.
 */
export const WORKSPACE_SUMMARY_SELECT = {
  id: true,
  name: true,
  slug: true,
  organizationId: true,
  feedbackEnabled: true,
  roadmapPublic: true,
  portalAuthRequired: true,
  brandingPaletteId: true,
  brandingPrimaryHex: true,
  brandingFontPresetId: true,
  brandingFontFamily: true,
  brandingLogoUrl: true,
} satisfies Prisma.WorkspaceSelect

export type WorkspaceSummary = WorkspaceBrandingFields & {
  id: string
  name: string
  slug: string
  organizationId: string
  feedbackEnabled: boolean | null
  roadmapPublic: boolean | null
  portalAuthRequired: boolean | null
}

export type WorkspaceContext =
  | { status: "unauthenticated" }
  /**
   * The workspace does not exist, OR it exists and the caller is not a member.
   * Deliberately indistinguishable — it matches the existing `getWorkspace()`
   * contract (which returns null for both) and avoids leaking the existence of
   * workspaces the caller has no access to.
   */
  | { status: "not-found" }
  | {
      status: "ok"
      user: SessionUser
      userId: string
      workspace: WorkspaceSummary
      orgSlug: string
      workspaceSlug: string
      /** Raw stored value; the column is a bare VarChar. Prefer isOrgAdmin. */
      orgRole: string | null
      isOrgAdmin: boolean
    }

/**
 * Resolves everything the workspace chrome needs — session, workspace, and the
 * caller's organization role — once per request.
 *
 * Both arguments are primitives, so React's cache keys them by value.
 *
 * Shape notes:
 *   - The two queries run under `Promise.all`: they are independent once the
 *     user id is known, and this keeps the resolver at one round-trip phase.
 *   - `organization: { slug }` and `members: { some: { userId } }` are relation
 *     *filters*, which compile to subqueries inside the single statement. Only
 *     relation *selects* cost an extra statement, because the generator sets no
 *     `previewFeatures` so `relationJoins` is off and Prisma's load strategy is
 *     "query". That is why this uses a flat select rather than an include.
 *   - The membership filter is what makes this an authorization check as well
 *     as a fetch. Do not remove it to "simplify" the query.
 *
 * This function must never call `redirect()` or `notFound()` — see
 * `requireWorkspaceContext` below for why.
 */
export const getWorkspaceContext = cache(
  async (orgSlug: string, workspaceSlug: string): Promise<WorkspaceContext> => {
    const user = await getSessionUser()
    if (!user) return { status: "unauthenticated" }

    const prisma = getPrisma()
    const [workspace, orgMember] = await Promise.all([
      prisma.workspace.findFirst({
        where: {
          slug: workspaceSlug,
          organization: { slug: orgSlug },
          members: { some: { userId: user.id } },
        },
        select: WORKSPACE_SUMMARY_SELECT,
      }),
      prisma.organizationMember.findFirst({
        where: { organization: { slug: orgSlug }, userId: user.id },
        select: { role: true },
      }),
    ])

    if (!workspace) return { status: "not-found" }

    return {
      status: "ok",
      user,
      userId: user.id,
      workspace,
      orgSlug,
      workspaceSlug,
      orgRole: orgMember?.role ?? null,
      isOrgAdmin: isOrgAdminRole(orgMember?.role),
    }
  }
)

export type ResolvedWorkspaceContext = Extract<WorkspaceContext, { status: "ok" }>

/**
 * Page/layout convention: redirect the signed-out, 404 everyone else.
 *
 * Deliberately NOT memoized, even though the resolver it calls is. `redirect()`
 * and `notFound()` work by throwing control-flow signals, and a cached function
 * has exactly one outcome per (function, arguments) key — so memoizing the
 * throw would let the first caller's intent silently win for every later caller
 * in the same request. Callers genuinely disagree about what to do: the
 * workspace layout wants notFound(), the settings page wants a redirect to
 * /dashboard, the workspace-search route wants a 404 JSON body, and the task
 * actions want a thrown Error. Keeping the control flow in thin uncached
 * wrappers lets each caller pick, while the query underneath still dedupes.
 */
export async function requireWorkspaceContext(
  orgSlug: string,
  workspaceSlug: string
): Promise<ResolvedWorkspaceContext> {
  const ctx = await getWorkspaceContext(orgSlug, workspaceSlug)
  if (ctx.status === "unauthenticated") redirect("/login")
  if (ctx.status === "not-found") notFound()
  return ctx
}

/**
 * Server-action convention: throw instead of redirecting.
 *
 * Reuses `PermissionError` and the exact message strings already produced by
 * lib/permissions.ts, so existing `.rejects.toThrow("Unauthorized")` /
 * `.rejects.toThrow("Workspace not found")` assertions keep meaning the same
 * thing.
 */
export async function requireWorkspaceContextOrThrow(
  orgSlug: string,
  workspaceSlug: string
): Promise<ResolvedWorkspaceContext> {
  const ctx = await getWorkspaceContext(orgSlug, workspaceSlug)
  if (ctx.status === "unauthenticated") throw new PermissionError("Unauthorized")
  if (ctx.status === "not-found") throw new PermissionError("Workspace not found")
  return ctx
}

export const getWorkspace = cache(
  async (
    orgSlug: string,
    workspaceSlug: string,
    userId: string
  ): Promise<(Workspace & { organization: Organization }) | null> => {
    const prisma = getPrisma()

    const workspace = await prisma.workspace.findFirst({
      where: {
        slug: workspaceSlug,
        organization: { slug: orgSlug },
        members: {
          some: { userId },
        },
      },
      include: {
        organization: true,
      },
    })

    return workspace
  }
)

export const getOrgWorkspaces = cache(
  async (
    orgSlug: string,
    userId: string
  ): Promise<Array<{ id: string; name: string; slug: string }>> => {
    const prisma = getPrisma()
    const workspaces = await prisma.workspace.findMany({
      where: {
        organization: { slug: orgSlug },
        members: { some: { userId } },
      },
      select: { id: true, name: true, slug: true },
      orderBy: { name: "asc" },
    })
    return workspaces
  }
)

/**
 * The sidebar's workspace switcher.
 *
 * Queries `workspace` directly rather than walking `workspaceMember` with a
 * two-level include. The previous shape cost three statements (members, then
 * workspaces, then organizations) and hydrated every column of every workspace
 * and organization — including `ssoSecretEncrypted` — only to throw all but
 * five scalars away in the map below. Expressing the membership as a relation
 * *filter* keeps it to two statements and five columns.
 *
 * Ordering by `name` on the workspace table rather than by the related
 * workspace's name through the join table also drops an order-by-relation.
 *
 * Incidental correctness: `@@unique([workspaceId, userId])` is enforced by
 * Prisma rather than the database (`relationMode = "prisma"`), so duplicate
 * membership rows are possible. The old shape returned the workspace once per
 * membership row; this one cannot double-list a workspace.
 */
export const getUserWorkspaces = cache(
  async (userId: string): Promise<UserWorkspace[]> => {
    const prisma = getPrisma()
    const workspaces = await prisma.workspace.findMany({
      where: { members: { some: { userId } } },
      select: {
        id: true,
        name: true,
        slug: true,
        organization: { select: { slug: true, name: true } },
      },
      orderBy: { name: "asc" },
    })
    return workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      orgSlug: workspace.organization.slug,
      orgName: workspace.organization.name,
    }))
  }
)
