import type { AppPrismaClient } from "@/lib/db";

/** Ordinary deletion cannot authorize physical cleanup or discard its evidence. */
export async function assertDocumentPilotCleanupReviewed(prisma: AppPrismaClient, workspaceId: string): Promise<void> {
  if (process.env.GEODE_DOCS_PILOT_WORKSPACE_ID === workspaceId) {
    throw new Error("Geode document pilot requires explicit cleanup review before workspace deletion");
  }
  const where = { workspaceId };
  const select = { id: true } as const;
  const inventory = await prisma.docStorageObject.findFirst({ where, select });
  const receipt = await prisma.docOperation.findFirst({ where, select });
  const document = await prisma.doc.findFirst({ where: { workspaceId, storageProvider: "GEODE" }, select });
  if (inventory || receipt || document) {
    throw new Error("Geode document pilot requires explicit cleanup review before workspace deletion");
  }
}
