import { notFound } from "next/navigation"
import { ResearchExperience } from "@/components/research/research-experience"
import { resolveActiveResearchStudy } from "@/lib/research-access"

export default async function ParticipantResearchPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const resolved = await resolveActiveResearchStudy(token)
  if (!resolved) notFound()
  const { study } = resolved
  const guided = study.studyType === "USABILITY_TEST" && Boolean(study.appUrl)
  return <main className={`mx-auto flex min-h-screen flex-col px-4 py-6 sm:py-10 ${guided ? "max-w-[100rem]" : "max-w-2xl"}`}><div className="mb-6"><div className="text-sm font-semibold text-primary">Compass research</div><h1 className="mt-2 text-2xl font-semibold">{study.name}</h1><p className="mt-2 text-text-subtle">{study.goal}</p><p className="mt-2 text-sm text-text-muted">About {study.targetMinutes} minutes · Your responses will be shared with the research team.</p></div><ResearchExperience token={token} studyName={study.name} studyType={study.studyType as "CUSTOMER_INTERVIEW" | "USABILITY_TEST"} appUrl={study.appUrl} /></main>
}
