import Link from "next/link"
import { redirect, notFound } from "next/navigation"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { PageHeader } from "@/components/patterns/page-header"
import { Button } from "@/components/ui/button"
import { isPmInterviewEnabled, isResearchCaptureEnabled } from "@/lib/research-feature"
import { parseResearchPage } from "@/lib/research-analysis"
import { externalProviderLabel } from "@/lib/research-external"

export const metadata = { title: "Research" }

export default async function CapturePage({ params, searchParams }: { params: Promise<{ orgSlug: string; workspaceSlug: string }>; searchParams?: Promise<{ page?: string; archived?: string }> }) {
  if (!isResearchCaptureEnabled()) notFound()
  const session = await auth(); if (!session?.user?.id) redirect("/login")
  const { orgSlug, workspaceSlug } = await params
  const query = await searchParams
  const page = parseResearchPage(query?.page)
  const archived = query?.archived === "1"
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findFirst({ where: { slug: workspaceSlug, organization: { slug: orgSlug }, members: { some: { userId: session.user.id } } }, select: { id: true, name: true } })
  if (!workspace) notFound()
  const studies = await prisma.researchStudy.findMany({ where: { workspaceId: workspace.id, status: archived ? "ARCHIVED" : { not: "ARCHIVED" } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * 20, take: 21, include: { pmInterview: { select: { id: true } }, _count: { select: { sessions: true } } } })
  return <main className="flex flex-1 flex-col gap-6 p-4 sm:p-6 md:p-8">
    <PageHeader title="Research" description={<>Customer interviews, usability tests, and external studies for {workspace.name}</>} actions={<div className="flex flex-wrap gap-2">{isPmInterviewEnabled() && <Button variant="outline" render={<Link href={`/${orgSlug}/${workspaceSlug}/capture/pm/new`} />}>PM interview</Button>}<Button variant="outline" render={<Link href={`/${orgSlug}/${workspaceSlug}/capture/new/external`} />}>Manual / external study</Button><Button render={<Link href={`/${orgSlug}/${workspaceSlug}/capture/new`} />}>New study</Button></div>} />
    <Link className="text-sm underline" href={`/${orgSlug}/${workspaceSlug}/capture${archived ? "" : "?archived=1"}`}>{archived ? "View current studies" : "View archived studies"}</Link>
    {studies.length === 0 ? <div className="rounded-xl border border-dashed p-10 text-center text-sm text-text-subtle">No studies on this page. Create one to start capturing customer conversations.</div> : <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{studies.slice(0, 20).map(study => <Link key={study.id} href={study.pmInterview ? `/${orgSlug}/${workspaceSlug}/capture/pm/${study.pmInterview.id}` : `/${orgSlug}/${workspaceSlug}/capture/studies/${study.id}`} className="rounded-xl border bg-surface-panel p-5 shadow-sm transition hover:border-border-strong"><div className="text-xs font-medium text-primary">{study.studyType === "PM_INTERVIEW" ? "PM interview" : study.studyType === "USABILITY_TEST" ? "Usability test" : study.studyType === "EXTERNAL" ? `External study${study.externalProvider ? ` · ${externalProviderLabel(study.externalProvider)}` : ""}` : "Customer interview"}</div><div className="mt-1 font-semibold">{study.name}</div><p className="mt-1 line-clamp-2 text-sm text-text-subtle">{study.goal}</p><div className="mt-4 text-xs text-text-muted">{study._count.sessions} sessions · {study.status.toLowerCase()}</div></Link>)}</div>}
    <nav aria-label="Study pages" className="flex gap-4 text-sm">{page > 1 && <Link className="underline" href={`/${orgSlug}/${workspaceSlug}/capture?page=${page - 1}&archived=${archived ? 1 : 0}`}>Previous studies</Link>}<span>Page {page}</span>{studies.length > 20 && <Link className="underline" href={`/${orgSlug}/${workspaceSlug}/capture?page=${page + 1}&archived=${archived ? 1 : 0}`}>Next studies</Link>}</nav>
  </main>
}
