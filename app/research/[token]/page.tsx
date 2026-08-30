import { notFound } from "next/navigation"
import { ResearchChat } from "@/components/research/research-chat"
import { resolveActiveResearchStudy } from "@/lib/research-access"

export default async function ParticipantResearchPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const resolved = await resolveActiveResearchStudy(token)
  if (!resolved) notFound()
  const { study } = resolved
  return <main className="mx-auto flex min-h-screen max-w-2xl flex-col px-4 py-10"><div className="mb-8"><div className="text-sm font-semibold text-primary">Compass research</div><h1 className="mt-2 text-2xl font-semibold">{study.name}</h1><p className="mt-2 text-text-subtle">{study.goal}</p><p className="mt-2 text-sm text-text-muted">About {study.targetMinutes} minutes · Your responses will be shared with the research team.</p></div><ResearchChat token={token} /></main>
}
