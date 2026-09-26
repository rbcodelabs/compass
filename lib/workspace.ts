import { cache } from "react"
import type { Organization, Workspace } from "@prisma/client"
import getPrisma from "@/lib/db"

export type UserWorkspace = {
  id: string
  name: string
  slug: string
  orgSlug: string
  orgName: string
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
      // Belt and braces. `@@unique([organizationId, slug])` (schema.prisma) is
      // a real index — `workspaces_organization_id_slug_key`, created by
      // 001_init — so two workspaces cannot share a slug within one org and
      // this findFirst can only ever match one row today.
      //
      // The orderBy is here anyway because *without* it the failure mode of
      // that invariant ever lapsing is silent and awful rather than loud: an
      // unordered findFirst would resolve /{org}/{slug} to a different row
      // from one request to the next, so writes made against one workspace
      // would appear and disappear at random rather than erroring. Pinning
      // the oldest row makes any such lapse degrade into "the newer duplicate
      // is unreachable", which is diagnosable.
      orderBy: { createdAt: "asc" },
    })

    return workspace
  }
)

/**
 * Membership of one workspace by internal user id — the whole predicate, nothing
 * else.
 *
 * Exists because the two checks that gate internal-SSO widget commenting have to
 * be the same check. One runs when the sign-in popup deposits a handoff; the
 * other runs again at write time, because a 12-hour visitor session can outlive
 * the membership that justified it. If those were two inline `findFirst` calls,
 * nothing would keep them agreeing — and the failure would be silent in the
 * direction that matters, a revoked member still able to write.
 *
 * Deliberately NOT the same predicate as `resolveWorkspaceAdmin` in
 * lib/permissions.ts, which also admits organization admins. An org admin who is
 * not a member of this workspace has no business commenting on its prototype
 * through a third party's page; "internal team" here means the workspace's own
 * members. It takes a `workspaceId` rather than slugs for the same reason — the
 * caller has resolved a FeedbackSource, not a URL.
 *
 * Not wrapped in `cache()`, unlike its neighbours: the write-time recheck exists
 * precisely to observe current state, and this is also called from route handlers
 * rather than only from the component tree.
 */
export async function isWorkspaceMember(workspaceId: string, userId: string): Promise<boolean> {
  const prisma = getPrisma()
  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId },
    select: { id: true },
  })
  return membership !== null
}

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
 *
 * ── Orphan defense, carried over from #247 ────────────────────────────────
 * That fix guarded a dereference of `membership.workspace`, which this shape
 * no longer performs: rows come from the workspace table itself, so a
 * WorkspaceMember pointing at a deleted Workspace simply does not match the
 * relation filter. It is dropped by the query rather than by a guard.
 *
 * The *other* half of #247's concern survives and is still handled below.
 * Aurora DSQL runs with relationMode="prisma", so there are no database-level
 * FK constraints and a Workspace row can outlive the Organization it points
 * at. Prisma types `organization` as non-nullable but resolves it to null in
 * that case, so an unguarded `workspace.organization.slug` would throw for
 * every workspace in the result, not just the dangling one — 500ing a user's
 * entire authenticated surface, which is exactly the production failure #247
 * was written for. Drop the orphan and log it rather than crash or let it
 * vanish silently.
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
    return workspaces.flatMap((workspace): UserWorkspace[] => {
      if (!workspace.organization) {
        console.error(
          `[getUserWorkspaces] Dropping orphaned Workspace ${workspace.id} for user ${userId}: ` +
            `it has no resolvable organization row.`
        )
        return []
      }
      return [{
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        orgSlug: workspace.organization.slug,
        orgName: workspace.organization.name,
      }]
    })
  }
)
