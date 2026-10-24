import getPrisma from "@/lib/db"
import { hashResearchToken } from "@/lib/research"
import { isResearchCaptureEnabled } from "@/lib/research-feature"

/**
 * The workspace a participant token belongs to, or null for an unknown token. A bare lookup, no validity checks: callers use it only to
 * decide WHICH workspace's module settings apply before they run the strict resolvers below, which still check status and expiry.
 */
export async function findResearchTokenWorkspaceId(token: string): Promise<string | null> {
  const participantToken = await getPrisma().researchParticipantToken.findUnique({
    where: { tokenHash: hashResearchToken(token) }, select: { study: { select: { workspaceId: true } } },
  })
  return participantToken?.study.workspaceId ?? null
}

// Cleanup only: the original token establishes study/tenant context even after
// revocation. The caller must still verify session, resume secret and exact lease.
export async function resolveResearchVoiceCleanupStudy(token: string) {
  const prisma = getPrisma()
  const participantToken = await prisma.researchParticipantToken.findUnique({
    where: { tokenHash: hashResearchToken(token) }, include: { study: true },
  })
  if (!participantToken || !["PRIMARY", "LEGACY_HELIO"].includes(participantToken.kind) || !["CUSTOMER_INTERVIEW", "USABILITY_TEST"].includes(participantToken.study.studyType)) return null
  // The token establishes the study's workspace; the module is that workspace's, not the deployment's.
  if (!(await isResearchCaptureEnabled(participantToken.study.workspaceId))) return null
  return { prisma, study: participantToken.study, participantToken }
}

export async function resolveActiveResearchStudy(token: string) {
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
  if (!(await isResearchCaptureEnabled(participantToken.study.workspaceId))) return null

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
