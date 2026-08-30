import getPrisma from "@/lib/db"
import { hashResearchToken } from "@/lib/research"
import { isResearchCaptureEnabled } from "@/lib/research-feature"

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
