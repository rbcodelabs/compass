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
