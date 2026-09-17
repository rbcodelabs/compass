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
