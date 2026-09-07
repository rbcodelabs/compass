import getPrisma from "@/lib/db"

type PrismaClient = ReturnType<typeof getPrisma>

type CapabilityPackCleanupClient = {
  workspaceCapabilityPack: Pick<PrismaClient["workspaceCapabilityPack"], "deleteMany">
  capabilityPackVersion: Pick<PrismaClient["capabilityPackVersion"], "deleteMany">
  capabilityPack: Pick<PrismaClient["capabilityPack"], "findMany" | "deleteMany">
}

/** Deletes workspace-owned pack rows in DSQL-safe child-first order.
 * Immutable blobs are retained until a future race-safe global GC exists. */
export async function deleteWorkspaceCapabilityPacks(
  prisma: CapabilityPackCleanupClient,
  workspaceId: string
) {
  const packs = await prisma.capabilityPack.findMany({
    where: { workspaceId },
    select: { id: true },
  })
  const packIds = packs.map((pack) => pack.id)
  await prisma.workspaceCapabilityPack.deleteMany({ where: { workspaceId } })
  if (packIds.length > 0) {
    await prisma.capabilityPackVersion.deleteMany({ where: { capabilityPackId: { in: packIds } } })
    await prisma.capabilityPack.deleteMany({ where: { id: { in: packIds } } })
  }

}
