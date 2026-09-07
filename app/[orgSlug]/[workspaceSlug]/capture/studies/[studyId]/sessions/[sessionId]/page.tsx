import Link from "next/link"
import { ResearchAttachmentLink } from "@/components/research/research-attachment-link"
import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { isResearchCaptureEnabled } from "@/lib/research-feature"
import { parseResearchPage } from "@/lib/research-analysis"
import { deserializeResearchGuide } from "@/lib/research"
import { SessionAnalysisResults } from "@/components/research/analysis-results"
import { PageHeader } from "@/components/patterns/page-header"

export default async function ResearchSessionPage({ params, searchParams }: { params: Promise<{ orgSlug: string; workspaceSlug: string; studyId: string; sessionId: string }>; searchParams: Promise<{ page?: string; attachmentPage?: string; turnId?: string }> }) {
  if (!isResearchCaptureEnabled()) notFound()
  const member = await auth()
  if (!member?.user?.id) redirect("/login")
  const { orgSlug, workspaceSlug, studyId, sessionId } = await params
  const query = await searchParams
  const prisma = getPrisma()
  const session = await prisma.researchSession.findFirst({ where: { id: sessionId, studyId, study: { workspace: { slug: workspaceSlug, organization: { slug: orgSlug }, members: { some: { userId: member.user.id } } } } }, include: { study: true, _count: { select: { turns: true } } } })
  if (!session) notFound()
  let page = parseResearchPage(query.page)
  if (query.turnId) {
    const anchor = await prisma.researchTurn.findFirst({ where: { id: query.turnId, sessionId }, select: { sequence: true } })
    if (anchor) page = Math.floor(await prisma.researchTurn.count({ where: { sessionId, sequence: { lt: anchor.sequence } } }) / 50) + 1
  }
  const attachmentPage = parseResearchPage(query.attachmentPage)
  const [turns, attachments] = await Promise.all([
    prisma.researchTurn.findMany({ where: { sessionId }, orderBy: { sequence: "asc" }, skip: (page - 1) * 50, take: 51 }),
    prisma.researchAttachment.findMany({ where: { sessionId, studyId, status: "READY" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip: (attachmentPage - 1) * 20, take: 21 }),
  ])
  const studyUrl = `/${orgSlug}/${workspaceSlug}/capture/studies/${studyId}`
  const url = `${studyUrl}/sessions/${sessionId}`
  return <main className="flex flex-1 flex-col gap-6 p-4 sm:p-6 md:p-8">
    <Link className="text-sm underline" href={studyUrl}>Back to study</Link>
    <PageHeader title={`${session.modality === "VOICE" ? "Voice" : "Chat"} interview`} description={`${session.study.name} · ${session.status.toLowerCase()} · ${session._count.turns} saved turns`} />
    <p className="text-sm text-text-muted">Started {session.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC{session.modality === "VOICE" ? ". Voice source is unverified in this view. Browser voice transcripts are participant-reported evidence." : ""}</p>
    <section className="max-w-3xl rounded-xl border bg-surface-panel p-5"><SessionAnalysisResults studyId={studyId} sessionId={sessionId} status={session.status} summary={session.summary} guide={deserializeResearchGuide(session.study.guide)} sessionUrl={url} /></section>
    <section className="max-w-3xl"><h2 className="font-semibold">Saved transcript</h2><ol className="mt-3 space-y-3">{turns.slice(0, 50).map(turn => <li id={`turn-${turn.id}`} key={turn.id} className="scroll-mt-20 rounded-lg border bg-surface-panel p-4 text-sm"><span className="font-medium">{turn.role === "PARTICIPANT" ? "Participant" : "Interviewer"}:</span><p className="mt-1 whitespace-pre-wrap break-words">{turn.content || "Attachment shared"}</p></li>)}</ol>
      <nav aria-label="Transcript pages" className="mt-4 flex gap-4 text-sm">{page > 1 && <Link className="underline" href={`${url}?page=${page - 1}&attachmentPage=${attachmentPage}`}>Previous turns</Link>}<span>Page {page}</span>{turns.length > 50 && <Link className="underline" href={`${url}?page=${page + 1}&attachmentPage=${attachmentPage}`}>Next turns</Link>}</nav>
    </section>
    <section className="max-w-3xl"><h2 className="font-semibold">Attachments</h2><div className="mt-3 flex flex-wrap gap-3">{attachments.slice(0, 20).map(attachment => <div key={attachment.id} className="max-w-64 rounded-lg border p-3 text-sm"><ResearchAttachmentLink url={`/api/research/member-attachments/${attachment.id}`} originalName={attachment.originalName} mimeType={attachment.mimeType} /></div>)}</div>
      <nav aria-label="Attachment pages" className="mt-4 flex gap-4 text-sm">{attachmentPage > 1 && <Link className="underline" href={`${url}?page=${page}&attachmentPage=${attachmentPage - 1}`}>Previous attachments</Link>}{attachments.length > 20 && <Link className="underline" href={`${url}?page=${page}&attachmentPage=${attachmentPage + 1}`}>Next attachments</Link>}</nav>
    </section>
  </main>
}
