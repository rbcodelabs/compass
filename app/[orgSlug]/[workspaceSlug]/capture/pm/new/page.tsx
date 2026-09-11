import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { Button } from "@/components/ui/button"
import { PageHeader } from "@/components/patterns/page-header"
import { isPmInterviewEnabled } from "@/lib/research-feature"
import { launchPmInterview } from "../actions"

export default async function NewPmInterviewPage({ params, searchParams }: { params: Promise<{ orgSlug: string; workspaceSlug: string }>; searchParams: Promise<{ targetType?: string; targetId?: string }> }) {
  if (!isPmInterviewEnabled()) notFound()
  const member = await auth(); if (!member?.user?.id) redirect("/login")
  const { orgSlug, workspaceSlug } = await params, selected = await searchParams, prisma = getPrisma()
  const workspace = await prisma.workspace.findFirst({ where: { slug: workspaceSlug, organization: { slug: orgSlug }, members: { some: { userId: member.user.id } } }, select: { id: true } })
  if (!workspace) notFound()
  const [opportunities, solutions, assumptions, experiments] = await Promise.all([
    prisma.opportunity.findMany({ where: { workspaceId: workspace.id }, select: { id: true, title: true }, orderBy: { updatedAt: "desc" }, take: 100 }),
    prisma.solution.findMany({ where: { opportunity: { workspaceId: workspace.id } }, select: { id: true, title: true }, orderBy: { updatedAt: "desc" }, take: 100 }),
    prisma.assumption.findMany({ where: { solution: { opportunity: { workspaceId: workspace.id } } }, select: { id: true, title: true }, orderBy: { updatedAt: "desc" }, take: 100 }),
    prisma.experiment.findMany({ where: { workspaceId: workspace.id }, select: { id: true, title: true }, orderBy: { updatedAt: "desc" }, take: 100 }),
  ])
  const groups = [{ type: "OPPORTUNITY", label: "Opportunities", items: opportunities }, { type: "SOLUTION", label: "Solutions", items: solutions }, { type: "ASSUMPTION", label: "Assumptions", items: assumptions }, { type: "EXPERIMENT", label: "Experiments", items: experiments }]
  const action = launchPmInterview.bind(null, orgSlug, workspaceSlug)
  return <main className="flex flex-1 flex-col gap-6 p-4 sm:p-6 md:p-8"><PageHeader title="Flesh this out" description="Have a voice-first PM interview about an existing item, then review proposed improvements." /><form action={action} className="max-w-2xl space-y-5 rounded-xl border bg-surface-panel p-5"><label className="block text-sm font-medium">Choose an item<select name="target" className="mt-2 h-11 w-full rounded-lg border bg-background px-3" defaultValue={selected.targetType && selected.targetId ? `${selected.targetType}:${selected.targetId}` : ""} required>{!selected.targetId && <option value="">Select an opportunity, solution, assumption, or experiment</option>}{groups.map(group => <optgroup key={group.type} label={group.label}>{group.items.map(item => <option key={item.id} value={`${group.type}:${item.id}`}>{item.title}</option>)}</optgroup>)}</select></label><Button type="submit">Start PM interview</Button></form></main>
}
