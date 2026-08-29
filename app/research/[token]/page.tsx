import { notFound } from "next/navigation"
import getPrisma from "@/lib/db"
import { hashResearchToken } from "@/lib/research"
import { ResearchChat } from "@/components/research/research-chat"

export default async function ParticipantResearchPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const prisma = getPrisma()
  const study = await prisma.researchStudy.findUnique({ where: { shareTokenHash: hashResearchToken(token) }, select: { name: true, goal: true, targetMinutes: true, status: true, shareExpiresAt: true } })
  if (!study || study.status !== "ACTIVE" || !study.shareExpiresAt || study.shareExpiresAt < new Date()) notFound()
  return <main className="mx-auto flex min-h-screen max-w-2xl flex-col px-4 py-10"><div className="mb-8"><div className="text-sm font-semibold text-primary">Compass research</div><h1 className="mt-2 text-2xl font-semibold">{study.name}</h1><p className="mt-2 text-text-subtle">{study.goal}</p><p className="mt-2 text-sm text-text-muted">About {study.targetMinutes} minutes · Your responses will be shared with the research team.</p></div><ResearchChat token={token} /></main>
}
