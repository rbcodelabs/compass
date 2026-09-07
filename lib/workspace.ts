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
  return memberships.map(({ workspace }) => ({
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    orgSlug: workspace.organization.slug,
    orgName: workspace.organization.name,
  }))
}
