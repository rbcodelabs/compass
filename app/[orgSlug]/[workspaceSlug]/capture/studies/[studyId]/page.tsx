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

export default async function StudyPage({ params, searchParams }: { params: Promise<{ orgSlug: string; workspaceSlug: string; studyId: string }>; searchParams: Promise<{ token?: string }> }) {
  if (!isResearchCaptureEnabled()) notFound()
  const session = await auth()
  if (!session?.user?.id) redirect("/login")
  const { orgSlug, workspaceSlug, studyId } = await params
  const { token } = await searchParams
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
  await reconcileAbandonedResearchSessions(prisma, access.id)
  const study = await prisma.researchStudy.findUnique({
    where: { id: access.id },
    include: {
      sessions: {
        orderBy: { createdAt: "desc" },
        take: 50,
        include: {
          turns: { orderBy: { sequence: "asc" }, take: 200 },
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
        : <StudySettings action={update} protocolLocked={study.sessions.length > 0} study={study} />}
      <StudyLifecycleControls activate={activate} archive={archive} close={close} status={study.status} />
      <section className="max-w-3xl">
        <h2 className="mb-3 font-semibold">Sessions</h2>
        {study.sessions.length ? <div className="space-y-3">{study.sessions.map((researchSession) => <article key={researchSession.id} className="rounded-lg border bg-surface-panel p-4 text-sm">
          <div><span className="font-medium">{researchSession.modality === "VOICE" ? "Voice" : "Chat"} session</span><span className="ml-2 text-text-muted">{researchSession.status.toLowerCase()}</span></div>
          {researchSession.turns.length > 0 && <ol className="mt-3 space-y-2 border-t pt-3">{researchSession.turns.map((turn) => <li key={turn.id}><span className="font-medium">{turn.role === "INTERVIEWER" ? "Interviewer" : "Participant"}:</span> <span className="text-text-subtle">{turn.content}</span></li>)}</ol>}
          {researchSession.attachments.length > 0 && <div className="mt-4 border-t pt-3"><h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">Attachments</h3><div className="mt-2 flex flex-wrap gap-3">{researchSession.attachments.map((attachment) => {
            const href = `/api/research/member-attachments/${attachment.id}`
            return <a className="block rounded-lg border p-2 hover:bg-muted" href={href} key={attachment.id} target="_blank" rel="noopener noreferrer">{attachment.mimeType.startsWith("image/") && <Image alt="" className="mb-2 h-24 w-40 rounded object-cover" height={96} src={href} unoptimized width={160} />}<span className="block max-w-40 truncate text-xs underline">{attachment.originalName}</span></a>
          })}</div></div>}
        </article>)}</div> : <p className="rounded-xl border border-dashed p-8 text-center text-sm text-text-subtle">No participant sessions yet.</p>}
      </section>
    </main>
  )
}
