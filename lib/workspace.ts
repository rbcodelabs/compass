import getPrisma from "@/lib/db"
import type { Organization, Workspace } from "@prisma/client"

export type UserWorkspace = {
  id: string
  name: string
  slug: string
  orgSlug: string
  orgName: string
}

export async function getWorkspace(
  orgSlug: string,
  workspaceSlug: string,
  userId: string
): Promise<(Workspace & { organization: Organization }) | null> {
  const prisma = await getPrisma()

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

export async function getOrgWorkspaces(
  orgSlug: string,
  userId: string
): Promise<Array<{ id: string; name: string; slug: string }>> {
  const prisma = await getPrisma()
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

export async function getUserWorkspaces(
  userId: string
): Promise<UserWorkspace[]> {
  const prisma = await getPrisma()
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId },
    include: {
      workspace: {
        include: { organization: true },
      },
    },
    orderBy: { workspace: { name: "asc" } },
  })

  // Aurora DSQL runs with relationMode="prisma" — there are no database-level
  // FK constraints, so a WorkspaceMember row can outlive the Workspace (or
  // Organization) it points at if a delete and a concurrent write ever
  // interleave (see lib/delete-workspace-cascade.ts's own comment on this).
  // When that happens, Prisma's `include` resolves the relation to `null`
  // instead of failing the query, and `workspace.id` below would throw for
  // every membership in this result, not just the dangling one — which is
  // exactly what happened in production: one orphaned row 500s a user's
  // entire authenticated surface, since every workspace-scoped route calls
  // this via WorkspaceLayout. Drop anything dangling instead of crashing on
  // it; the user still sees every workspace they're actually still a member
  // of, and the orphan is logged instead of silently disappearing forever.
  return memberships.flatMap((membership): UserWorkspace[] => {
    const { workspace } = membership
    if (!workspace || !workspace.organization) {
      console.error(
        `[getUserWorkspaces] Dropping orphaned WorkspaceMember ${membership.id} for user ${userId}: ` +
          `workspaceId=${membership.workspaceId} has no resolvable workspace/organization row.`
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
