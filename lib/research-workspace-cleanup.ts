import type { AppPrismaClient } from "@/lib/db"
import { deleteLinksForEntity } from "@/lib/links/service"
import { deleteParticipantVoiceEvidenceIfPresent } from "@/lib/research-participant-voice-cleanup"

/** Delete the relationMode=prisma research graph children-first. Blob cleanup
 * receipts intentionally survive so uploaded objects can still be reclaimed. */
export async function deleteWorkspaceResearchData(prisma: AppPrismaClient, workspaceId: string) {
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
  // Join rows (experiment <-> study links) go BEFORE the studies: no foreign key reaches entity_links, so a study deleted first
  // would leave rows pointing at nothing. Both directions, in chunks of 500 links.
  const studies = await prisma.researchStudy.findMany({ where: { workspaceId }, select: { id: true } })
  await deleteLinksForEntity(prisma, "RESEARCH_STUDY", studies.map((study) => study.id))
  await prisma.researchStudy.deleteMany({ where: { workspaceId } })
}
