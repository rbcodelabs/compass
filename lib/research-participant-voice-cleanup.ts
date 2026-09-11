import type { PrismaClient } from "@prisma/client"

export async function deleteParticipantVoiceEvidenceIfPresent(prisma: PrismaClient, workspaceId: string) {
  try { await prisma.researchParticipantVoiceEvent.deleteMany({ where: { workspaceId } }) }
  catch (error) {
    // Old default-off deployments can clean their pre-049 fixtures. Never hide
    // permission, connection, constraint, or another table's missing-schema error.
    const known = error as { code?: string; meta?: { modelName?: string } }
    if (known.code !== "P2021" || known.meta?.modelName !== "ResearchParticipantVoiceEvent") throw error
  }
}
