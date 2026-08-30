import { notFound, redirect } from "next/navigation"
import getPrisma from "@/lib/db"
import { auth } from "@/auth"
import { PageHeader } from "@/components/patterns/page-header"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { regenerateResearchLink, revokeResearchLinks } from "../../actions"
import { isResearchCaptureEnabled } from "@/lib/research-feature"
import { hashResearchToken } from "@/lib/research"
import { researchParticipantUrl } from "@/lib/compass-url"
import { reconcileAbandonedResearchSessions } from "@/lib/research-session"

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
        include: { turns: { orderBy: { sequence: "asc" }, take: 200 } },
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
  return <main className="flex flex-1 flex-col gap-6 p-4 sm:p-6 md:p-8"><PageHeader title={study.name} description={study.goal} /><section className="max-w-3xl rounded-xl border bg-surface-panel p-5"><h2 className="font-semibold">Participant link</h2>{shareUrl ? <><Input className="mt-3" readOnly value={shareUrl} /><p className="mt-2 text-xs text-text-muted">Save this link now. Compass stores only its secure hash.</p></> : <p className="mt-2 text-sm text-text-subtle">For security, Compass cannot display an existing link again. {study.participantTokens.length ? `${study.participantTokens.length} active link${study.participantTokens.length === 1 ? " is" : "s are"} available.` : "There is no active participant link."}</p>}<div className="mt-3 flex gap-2"><form action={regenerate}><Button type="submit" variant="outline">{study.participantTokens.length ? "Rotate participant link" : "Generate participant link"}</Button></form>{study.participantTokens.length > 0 && <form action={revoke}><Button type="submit" variant="ghost">Revoke active links</Button></form>}</div></section><section className="max-w-3xl"><h2 className="mb-3 font-semibold">Sessions</h2>{study.sessions.length ? <div className="space-y-3">{study.sessions.map(s => <article key={s.id} className="rounded-lg border bg-surface-panel p-4 text-sm"><div><span className="font-medium">{s.modality.toLowerCase()} session</span><span className="ml-2 text-text-muted">{s.status.toLowerCase()}</span></div>{s.turns.length > 0 && <ol className="mt-3 space-y-2 border-t pt-3">{s.turns.map(turn => <li key={turn.id}><span className="font-medium">{turn.role === "INTERVIEWER" ? "Interviewer" : "Participant"}:</span> <span className="text-text-subtle">{turn.content}</span></li>)}</ol>}</article>)}</div> : <p className="rounded-xl border border-dashed p-8 text-center text-sm text-text-subtle">No participant sessions yet.</p>}</section></main>
}
