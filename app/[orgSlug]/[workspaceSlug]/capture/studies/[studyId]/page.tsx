import { notFound } from "next/navigation"
import getPrisma from "@/lib/db"
import { PageHeader } from "@/components/patterns/page-header"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { headers } from "next/headers"
import { regenerateResearchLink } from "../../actions"

export default async function StudyPage({ params, searchParams }: { params: Promise<{ orgSlug: string; workspaceSlug: string; studyId: string }>; searchParams: Promise<{ token?: string }> }) {
  const { orgSlug, workspaceSlug, studyId } = await params
  const { token } = await searchParams
  const requestHeaders = await headers()
  const prisma = getPrisma()
  const study = await prisma.researchStudy.findFirst({ where: { id: studyId, workspace: { slug: workspaceSlug, organization: { slug: orgSlug } } }, include: { sessions: { orderBy: { createdAt: "desc" } } } })
  if (!study) notFound()
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host")
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host?.includes("localhost") ? "http" : "https")
  const shareUrl = token && host ? `${protocol}://${host}/research/${token}` : null
  const regenerate = regenerateResearchLink.bind(null, orgSlug, workspaceSlug, study.id)
  return <main className="flex flex-1 flex-col gap-6 p-4 sm:p-6 md:p-8"><PageHeader title={study.name} description={study.goal} /><section className="max-w-3xl rounded-xl border bg-surface-panel p-5"><h2 className="font-semibold">Participant link</h2>{shareUrl ? <><Input className="mt-3" readOnly value={shareUrl} /><p className="mt-2 text-xs text-text-muted">Save this link now. Compass stores only its secure hash.</p></> : <><p className="mt-2 text-sm text-text-subtle">For security, Compass cannot display the existing link again. Generate a new one when you need to share this study.</p><form action={regenerate} className="mt-3"><Button type="submit" variant="outline">Generate new link</Button></form></>}</section><section className="max-w-3xl"><h2 className="mb-3 font-semibold">Sessions</h2>{study.sessions.length ? <div className="space-y-2">{study.sessions.map(s => <div key={s.id} className="rounded-lg border bg-surface-panel p-4 text-sm"><span className="font-medium">{s.modality.toLowerCase()} session</span><span className="ml-2 text-text-muted">{s.status.toLowerCase()}</span></div>)}</div> : <p className="rounded-xl border border-dashed p-8 text-center text-sm text-text-subtle">No participant sessions yet.</p>}</section></main>
}
