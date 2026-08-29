import Link from "next/link"
import { redirect, notFound } from "next/navigation"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { PageHeader } from "@/components/patterns/page-header"
import { Button } from "@/components/ui/button"

export const metadata = { title: "Capture" }

export default async function CapturePage({ params }: { params: Promise<{ orgSlug: string; workspaceSlug: string }> }) {
  const session = await auth(); if (!session?.user?.id) redirect("/login")
  const { orgSlug, workspaceSlug } = await params
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findFirst({ where: { slug: workspaceSlug, organization: { slug: orgSlug }, members: { some: { userId: session.user.id } } }, select: { id: true, name: true } })
  if (!workspace) notFound()
  const studies = await prisma.researchStudy.findMany({ where: { workspaceId: workspace.id, status: { not: "ARCHIVED" } }, orderBy: { createdAt: "desc" }, include: { _count: { select: { sessions: true } } } })
  return <main className="flex flex-1 flex-col gap-6 p-4 sm:p-6 md:p-8">
    <PageHeader title="Capture" description={<>Feedback, ideas, and research for {workspace.name}</>} actions={<Button render={<Link href={`/${orgSlug}/${workspaceSlug}/capture/new`} />}>New study</Button>} />
    <div className="flex gap-4 border-b border-border"><Link className="border-b-2 border-primary px-1 pb-3 text-sm font-medium" href={`/${orgSlug}/${workspaceSlug}/capture`}>Studies</Link><Link className="px-1 pb-3 text-sm text-text-subtle" href={`/${orgSlug}/${workspaceSlug}/feedback`}>Inbox</Link></div>
    {studies.length === 0 ? <div className="rounded-xl border border-dashed p-10 text-center text-sm text-text-subtle">No studies yet. Create one to start capturing customer conversations.</div> : <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{studies.map(study => <Link key={study.id} href={`/${orgSlug}/${workspaceSlug}/capture/studies/${study.id}`} className="rounded-xl border bg-surface-panel p-5 shadow-sm transition hover:border-border-strong"><div className="font-semibold text-text-primary">{study.name}</div><p className="mt-1 line-clamp-2 text-sm text-text-subtle">{study.goal}</p><div className="mt-4 text-xs text-text-muted">{study._count.sessions} sessions · {study.status.toLowerCase()}</div></Link>)}</div>}
  </main>
}
