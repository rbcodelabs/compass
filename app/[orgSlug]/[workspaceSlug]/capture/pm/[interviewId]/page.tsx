import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import { readPmInterview } from "@/lib/pm-interview-service"
import { isPmInterviewEnabled, isResearchBrowserVoiceEnabled } from "@/lib/research-feature"
import { PmInterviewExperience } from "@/components/research/pm-interview-experience"
import { PageHeader } from "@/components/patterns/page-header"

export default async function PmInterviewPage({ params }: { params: Promise<{ orgSlug: string; workspaceSlug: string; interviewId: string }> }) {
  if (!isPmInterviewEnabled()) notFound()
  const session = await auth(); if (!session?.user?.id) redirect("/login")
  const { orgSlug, workspaceSlug, interviewId } = await params
  const interview = await readPmInterview({ orgSlug, workspaceSlug }, { userId: session.user.id }, interviewId).catch(() => null)
  if (!interview) notFound()
  return <main className="flex flex-1 flex-col gap-6 p-4 sm:p-6 md:p-8"><Link className="text-sm underline" href={`/${orgSlug}/${workspaceSlug}/capture`}>Back to Capture</Link><PageHeader title="Flesh this out" description={`${interview.targetType.toLowerCase()} · PM interview`} /><PmInterviewExperience interviewId={interview.id} orgSlug={orgSlug} workspaceSlug={workspaceSlug} targetType={interview.targetType as never} targetTitle={String(interview.context.target.fields.title)} omissions={interview.context.omissions} initialTurns={interview.session.turns.map(turn => ({ id: turn.id, role: turn.role, content: turn.content, sequence: turn.sequence }))} initialProposal={interview.proposal as never} initialDisposition={interview.disposition} initialGenerationState={interview.generationState} initialReviewBaseline={interview.reviewBaseline} initialContextFields={interview.context.target.fields} applicationDisabledReason={interview.applicationDisabledReason} owner={interview.owner} voiceEnabled={isResearchBrowserVoiceEnabled()} /></main>
}
