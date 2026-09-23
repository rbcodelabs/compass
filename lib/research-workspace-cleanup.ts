import type { AppPrismaClient } from "@/lib/db"
import { deleteParticipantVoiceEvidenceIfPresent } from "@/lib/research-participant-voice-cleanup"

/** Delete the relationMode=prisma research graph children-first. Blob cleanup
 * receipts intentionally survive so uploaded objects can still be reclaimed. */
export async function deleteWorkspaceResearchData(prisma: AppPrismaClient, workspaceId: string) {
  await prisma.experimentResearchStudyLink.deleteMany({ where: { workspaceId } })
  await prisma.researchVoiceCommand.deleteMany({ where: { session: { study: { workspaceId } } } })
  await prisma.researchVoiceEvent.deleteMany({ where: { session: { study: { workspaceId } } } })
  await prisma.researchVoiceCall.deleteMany({ where: { session: { study: { workspaceId } } } })
  await prisma.researchRequest.deleteMany({ where: { session: { study: { workspaceId } } } })
  await prisma.researchAttachment.deleteMany({ where: { workspaceId } })
  await deleteParticipantVoiceEvidenceIfPresent(prisma, workspaceId)
  await prisma.researchTurn.deleteMany({ where: { session: { study: { workspaceId } } } })
  await prisma.pMInterview.deleteMany({ where: { workspaceId } })
  await prisma.researchSession.deleteMany({ where: { study: { workspaceId } } })
  await prisma.researchParticipantToken.deleteMany({ where: { study: { workspaceId } } })
  await prisma.researchSynthesis.deleteMany({ where: { study: { workspaceId } } })
  await prisma.researchStudy.deleteMany({ where: { workspaceId } })
}
