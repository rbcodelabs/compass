import { notFound, redirect } from "next/navigation"
import getPrisma from "@/lib/db"
import { auth } from "@/auth"
import { PageHeader } from "@/components/patterns/page-header"
import { Input } from "@/components/ui/input"
import { activateResearchStudy, archiveResearchStudy, closeResearchStudy, regenerateResearchLink, revokeResearchLinks, updateResearchStudy } from "../../actions"
import { isResearchCaptureEnabled } from "@/lib/research-feature"
import { hashResearchToken } from "@/lib/research"
import { researchParticipantUrl } from "@/lib/compass-url"
import { reconcileAbandonedResearchSessions } from "@/lib/research-session"
import Image from "next/image"
import { StudySettings } from "@/components/research/study-settings"
import { ResearchSubmitButton } from "@/components/research/research-submit-button"
import { StudyLifecycleControls } from "@/components/research/study-lifecycle-controls"
import Link from "next/link"
import { SessionAnalysisResults, SynthesisResults } from "@/components/research/analysis-results"
import { guideFingerprint, parseResearchPage } from "@/lib/research-analysis"
import { deserializeResearchGuide } from "@/lib/research"

export default async function StudyPage({ params, searchParams }: { params: Promise<{ orgSlug: string; workspaceSlug: string; studyId: string }>; searchParams: Promise<{ token?: string; page?: string; synthesisPage?: string; turnId?: string }> }) {
  if (!isResearchCaptureEnabled()) notFound()
  const session = await auth()
  if (!session?.user?.id) redirect("/login")
  const { orgSlug, workspaceSlug, studyId } = await params
  const { token, page: requestedPage, synthesisPage: requestedSynthesisPage, turnId } = await searchParams
  const page = parseResearchPage(requestedPage)
  const synthesisPage = parseResearchPage(requestedSynthesisPage)
  const prisma = getPrisma()
  const access = await prisma.researchStudy.findFirst({
    where: {
      id: studyId,
      workspace: {
        slug: workspaceSlug,
        organization: { slug: orgSlug },
        members: { some: { userId: session.user.id } },
      },
    },
    select: { id: true },
  })
  if (!access) notFound()
  if (turnId) {
    const evidence = await prisma.researchTurn.findFirst({ where: { id: turnId, session: { studyId: access.id } }, select: { sessionId: true } })
    if (!evidence) notFound()
    redirect(`/${orgSlug}/${workspaceSlug}/capture/studies/${access.id}/sessions/${evidence.sessionId}?turnId=${encodeURIComponent(turnId)}#turn-${encodeURIComponent(turnId)}`)
  }
  await reconcileAbandonedResearchSessions(prisma, access.id)
  const study = await prisma.researchStudy.findUnique({
    where: { id: access.id },
    include: {
      _count: { select: { sessions: true } },
      syntheses: { where: { kind: "CROSS_SESSION" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (synthesisPage - 1) * 10, take: 11 },
      sessions: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * 20,
        take: 21,
        include: {
          _count: { select: { turns: true } },
          turns: { orderBy: { sequence: "asc" }, take: 20 },
          attachments: { where: { status: "READY" }, orderBy: { createdAt: "asc" }, take: 100 },
        },
      },
      participantTokens: {
        where: { revokedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true, kind: true, expiresAt: true, lastUsedAt: true },
      },
    },
  })
  if (!study) notFound()
  // Completed transcripts are immutable. Guide + completed IDs detect staleness without
  // rereading all turns; 501 is necessarily stale against any valid <=500-session snapshot.
  const completedSessions = await prisma.researchSession.findMany({ where: { studyId: study.id, status: "COMPLETED" }, select: { id: true }, take: 501 })
  const studyUrl = `/${orgSlug}/${workspaceSlug}/capture/studies/${study.id}`
  const guide = deserializeResearchGuide(study.guide)
  const displayedToken = token ? await prisma.researchParticipantToken.findFirst({
    where: {
      studyId: study.id,
      tokenHash: hashResearchToken(token),
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  }) : null
  const shareUrl = token && displayedToken ? researchParticipantUrl(token) : null
  const regenerate = regenerateResearchLink.bind(null, orgSlug, workspaceSlug, study.id)
  const revoke = revokeResearchLinks.bind(null, orgSlug, workspaceSlug, study.id)
  const update = updateResearchStudy.bind(null, orgSlug, workspaceSlug, study.id)
  const activate = activateResearchStudy.bind(null, orgSlug, workspaceSlug, study.id)
  const close = closeResearchStudy.bind(null, orgSlug, workspaceSlug, study.id)
  const archive = archiveResearchStudy.bind(null, orgSlug, workspaceSlug, study.id)
  const guided = study.studyType === "USABILITY_TEST"
  return (
    <main className="flex flex-1 flex-col gap-6 p-4 sm:p-6 md:p-8">
      <PageHeader title={study.name} description={study.goal} />
      <section className="flex max-w-3xl flex-wrap gap-x-6 gap-y-2 rounded-xl border bg-surface-panel p-4 text-sm">
        <div><span className="text-text-muted">Type</span><div className="font-medium">{guided ? "Guided usability test" : "Customer interview"}</div></div>
        <div><span className="text-text-muted">Target</span><div className="font-medium">{study.targetMinutes} minutes</div></div>
        <div><span className="text-text-muted">Status</span><div className="font-medium capitalize">{study.status.toLowerCase()}</div></div>
        {guided && study.appUrl && <div className="min-w-0"><span className="text-text-muted">Product</span><div><a className="break-all font-medium underline" href={study.appUrl} rel="noopener noreferrer" target="_blank">{study.appUrl}</a></div></div>}
      </section>
      <section className="max-w-3xl rounded-xl border bg-surface-panel p-5">
        <h2 className="font-semibold">Participant link</h2>
        {shareUrl ? <><Input aria-label="Participant link" className="mt-3" readOnly value={shareUrl} /><p className="mt-2 text-xs text-text-muted">Save this link now. Compass stores only its secure hash.</p></> : <p className="mt-2 text-sm text-text-subtle">For security, Compass cannot display an existing link again. {study.participantTokens.length ? `${study.participantTokens.length} active link${study.participantTokens.length === 1 ? " is" : "s are"} available.` : "There is no active participant link."}</p>}
        {study.status === "ACTIVE" && <div className="mt-3 flex gap-2"><form action={regenerate}><ResearchSubmitButton pendingLabel="Rotating…" variant="outline">{study.participantTokens.length ? "Rotate participant link" : "Generate participant link"}</ResearchSubmitButton></form>{study.participantTokens.length > 0 && <form action={revoke}><ResearchSubmitButton pendingLabel="Revoking…" variant="ghost">Revoke active links</ResearchSubmitButton></form>}</div>}
      </section>
      {study.status === "ARCHIVED"
        ? <p className="max-w-3xl rounded-xl border bg-surface-panel p-5 text-sm text-text-muted">This study is archived and retained for research review.</p>
        : <StudySettings action={update} protocolLocked={study._count.sessions > 0} study={study} />}
      <StudyLifecycleControls activate={activate} archive={archive} close={close} status={study.status} />
      <SynthesisResults snapshots={study.syntheses.slice(0, 10)} studyId={study.id} studyUrl={studyUrl} completedSessionIds={completedSessions.map(item => item.id)} currentGuideFingerprint={guideFingerprint(study.goal, guide)} />
      <nav aria-label="Synthesis history pages" className="flex gap-4 text-sm">{synthesisPage > 1 && <Link className="underline" href={`${studyUrl}?page=${page}&synthesisPage=${synthesisPage - 1}`}>Newer synthesis snapshots</Link>}{study.syntheses.length > 10 && <Link className="underline" href={`${studyUrl}?page=${page}&synthesisPage=${synthesisPage + 1}`}>Older synthesis snapshots</Link>}</nav>
      <section className="max-w-3xl">
        <h2 className="mb-3 font-semibold">Sessions</h2>
        {study.sessions.length ? <div className="space-y-3">{study.sessions.slice(0, 20).map((researchSession) => <article key={researchSession.id} className="rounded-lg border bg-surface-panel p-4 text-sm">
          <div><span className="font-medium">{researchSession.modality === "VOICE" ? "Voice" : "Chat"} session</span><span className="ml-2 text-text-muted">{researchSession.status.toLowerCase()}</span></div>
          <p className="mt-1 text-xs text-text-muted">{researchSession.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC · {researchSession._count.turns} saved turns</p>
          {researchSession.modality === "VOICE" && <p className="mt-2 text-xs text-text-muted">Voice source is unverified in this view. Browser voice transcripts are participant-reported evidence.</p>}
          <SessionAnalysisResults studyId={study.id} sessionId={researchSession.id} status={researchSession.status} summary={researchSession.summary} guide={guide} sessionUrl={`${studyUrl}/sessions/${researchSession.id}`} />
          {researchSession.turns.length > 0 && <ol className="mt-3 space-y-2 border-t pt-3">{researchSession.turns.map((turn) => <li key={turn.id}><span className="font-medium">{turn.role === "INTERVIEWER" ? "Interviewer" : "Participant"}:</span> <span className="text-text-subtle">{turn.content}</span></li>)}</ol>}
          {researchSession.attachments.length > 0 && <div className="mt-4 border-t pt-3"><h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">Attachments</h3><div className="mt-2 flex flex-wrap gap-3">{researchSession.attachments.map((attachment) => {
            const href = `/api/research/member-attachments/${attachment.id}`
            return <a className="block rounded-lg border p-2 hover:bg-muted" href={href} key={attachment.id} target="_blank" rel="noopener noreferrer">{attachment.mimeType.startsWith("image/") && <Image alt="" className="mb-2 h-24 w-40 rounded object-cover" height={96} src={href} unoptimized width={160} />}<span className="block max-w-40 truncate text-xs underline">{attachment.originalName}</span></a>
          })}</div></div>}
          <Link className="mt-3 inline-block underline" href={`${studyUrl}/sessions/${researchSession.id}`}>View full interview and attachments</Link>
        </article>)}</div> : <p className="rounded-xl border border-dashed p-8 text-center text-sm text-text-subtle">No participant sessions yet.</p>}
      </section>
      <nav aria-label="Session pages" className="flex gap-4 text-sm">{page > 1 && <Link className="underline" href={`${studyUrl}?page=${page - 1}&synthesisPage=${synthesisPage}`}>Previous sessions</Link>}<span>Page {page} · {study._count.sessions} sessions</span>{study.sessions.length > 20 && <Link className="underline" href={`${studyUrl}?page=${page + 1}&synthesisPage=${synthesisPage}`}>Next sessions</Link>}</nav>
    </main>
  )
}
