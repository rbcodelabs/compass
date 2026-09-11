import getPrisma from "@/lib/db"
import { hashResearchToken } from "@/lib/research"
import { isResearchCaptureEnabled } from "@/lib/research-feature"

// Cleanup only: the original token establishes study/tenant context even after
// revocation. The caller must still verify session, resume secret and exact lease.
export async function resolveResearchVoiceCleanupStudy(token: string) {
  if (!isResearchCaptureEnabled()) return null
  const prisma = getPrisma()
  const participantToken = await prisma.researchParticipantToken.findUnique({
    where: { tokenHash: hashResearchToken(token) }, include: { study: true },
  })
  return participantToken ? { prisma, study: participantToken.study, participantToken } : null
}

export async function resolveActiveResearchStudy(token: string) {
  if (!isResearchCaptureEnabled()) return null
  const prisma = getPrisma()
  const participantToken = await prisma.researchParticipantToken.findUnique({
    where: { tokenHash: hashResearchToken(token) },
    include: { study: true },
  })
  const now = new Date()
  if (
    !participantToken ||
    !["PRIMARY", "LEGACY_HELIO"].includes(participantToken.kind) ||
    !["CUSTOMER_INTERVIEW", "USABILITY_TEST"].includes(participantToken.study.studyType) ||
    participantToken.revokedAt ||
    participantToken.expiresAt.getTime() <= now.getTime() ||
    participantToken.study.status !== "ACTIVE"
  ) return null

  try {
    await prisma.researchParticipantToken.update({
      where: { id: participantToken.id },
      data: { lastUsedAt: now },
    })
  } catch (error) {
    console.error("[research] failed to update participant token lastUsedAt", error)
  }
  return { prisma, study: participantToken.study, participantToken }
}
