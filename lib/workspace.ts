import getPrisma from "@/lib/db"
import type { Organization, Workspace } from "@prisma/client"

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
