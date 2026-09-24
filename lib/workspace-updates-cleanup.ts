import type { AppPrismaClient } from "./db";

/** Cleanup must work even when capture is disabled after a rollback. */
export async function deleteWorkspaceUpdates(
  prisma: AppPrismaClient,
  workspaceId: string,
) {
  try {
    await prisma.workspaceUpdateEvent.deleteMany({ where: { workspaceId } });
    await prisma.workspaceUpdatesReadState.deleteMany({
      where: { workspaceId },
    });
    await prisma.workspaceUpdatesState.deleteMany({ where: { workspaceId } });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2021"
    )
      return;
    throw error;
  }
}
