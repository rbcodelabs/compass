import type { ArtifactStorage } from "@/lib/artifact-storage"
import getPrisma from "@/lib/db"
import { retryArtifactBlobCleanup } from "@/lib/artifacts"

type PrismaClient = ReturnType<typeof getPrisma>

type CapabilityPackCleanupClient = {
  workspaceCapabilityPack: Pick<PrismaClient["workspaceCapabilityPack"], "deleteMany">
  capabilityPackVersion: Pick<PrismaClient["capabilityPackVersion"], "findMany" | "deleteMany" | "findFirst">
  capabilityPack: Pick<PrismaClient["capabilityPack"], "findMany" | "deleteMany">
  artifactBlobCleanup: Pick<PrismaClient["artifactBlobCleanup"], "upsert" | "findMany" | "update" | "delete">
  artifactRevision: Pick<PrismaClient["artifactRevision"], "findFirst">
}

/** Deletes workspace-owned pack rows in DSQL-safe child-first order and queues
 * unreferenced immutable blobs for the same retryable cleanup used by artifacts. */
export async function deleteWorkspaceCapabilityPacks(
  prisma: CapabilityPackCleanupClient,
  workspaceId: string,
  storage: ArtifactStorage
) {
  const packs = await prisma.capabilityPack.findMany({
    where: { workspaceId },
    select: { id: true },
  })
  const packIds = packs.map((pack) => pack.id)
  const versions = packIds.length === 0 ? [] : await prisma.capabilityPackVersion.findMany({
    where: { capabilityPackId: { in: packIds } },
    select: { artifactPathname: true },
  })

  await prisma.workspaceCapabilityPack.deleteMany({ where: { workspaceId } })
  if (packIds.length > 0) {
    await prisma.capabilityPackVersion.deleteMany({ where: { capabilityPackId: { in: packIds } } })
    await prisma.capabilityPack.deleteMany({ where: { id: { in: packIds } } })
  }

  const pathnames = [...new Set(versions.map((version) => version.artifactPathname))]
  for (const blobPathname of pathnames) {
    const stillReferenced = await prisma.capabilityPackVersion.findFirst({
      where: { artifactPathname: blobPathname },
      select: { id: true },
    })
    if (!stillReferenced) {
      await prisma.artifactBlobCleanup.upsert({
        where: { blobPathname },
        create: { blobPathname, reason: "CAPABILITY_PACK_DELETE" },
        update: { reason: "CAPABILITY_PACK_DELETE", updatedAt: new Date() },
      })
    }
  }
  await retryArtifactBlobCleanup(prisma, storage, pathnames)
}
