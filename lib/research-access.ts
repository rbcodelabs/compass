import getPrisma from "@/lib/db"
import { hashResearchToken } from "@/lib/research"

export async function resolveActiveResearchStudy(token: string) {
  const prisma = getPrisma()
  const study = await prisma.researchStudy.findUnique({ where: { shareTokenHash: hashResearchToken(token) } })
  if (!study || study.status !== "ACTIVE" || !study.shareExpiresAt || study.shareExpiresAt < new Date()) return null
  return { prisma, study }
}
