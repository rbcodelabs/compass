import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { getWorkspace } from "@/lib/workspace"
import { PageHeader } from "@/components/patterns/page-header"
import { NewDecisionForm, type DecisionSubjectOption } from "@/components/decisions/new-decision-form"

export default async function NewDecisionPage({ params, searchParams }: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<{ subjectType?: string; subjectId?: string; reviseRequestId?: string }>
}) {
  const { orgSlug, workspaceSlug } = await params
  const query = await searchParams
  const session = await auth()
  if (!session?.user?.id) redirect("/login")
  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id)
  if (!workspace) notFound()
  const prisma = getPrisma()
  const [opportunities, solutions, roadmapItems, docs, experiments, feedback] = await Promise.all([
    prisma.opportunity.findMany({ where: { workspaceId: workspace.id }, select: { id: true, title: true }, orderBy: { updatedAt: "desc" }, take: 100 }),
    prisma.solution.findMany({ where: { opportunity: { workspaceId: workspace.id } }, select: { id: true, title: true }, orderBy: { updatedAt: "desc" }, take: 100 }),
    prisma.roadmapItem.findMany({ where: { workspaceId: workspace.id, status: "ACTIVE" }, select: { id: true, title: true }, orderBy: { updatedAt: "desc" }, take: 100 }),
    prisma.doc.findMany({ where: { workspaceId: workspace.id }, select: { id: true, title: true }, orderBy: { updatedAt: "desc" }, take: 100 }),
    prisma.experiment.findMany({ where: { workspaceId: workspace.id }, select: { id: true, title: true }, orderBy: { updatedAt: "desc" }, take: 100 }),
    prisma.feedbackItem.findMany({ where: { workspaceId: workspace.id }, select: { id: true, title: true }, orderBy: { updatedAt: "desc" }, take: 100 }),
  ])
  const subjects: DecisionSubjectOption[] = [
    { type: "WORKSPACE", id: workspace.id, title: workspace.name },
    ...opportunities.map((row) => ({ type: "OPPORTUNITY" as const, ...row })),
    ...solutions.map((row) => ({ type: "SOLUTION" as const, ...row })),
    ...roadmapItems.map((row) => ({ type: "ROADMAP_ITEM" as const, ...row })),
    ...docs.map((row) => ({ type: "DOC" as const, ...row })),
    ...experiments.map((row) => ({ type: "EXPERIMENT" as const, ...row })),
    ...feedback.map((row) => ({ type: "FEEDBACK" as const, ...row })),
  ]

  let initial = { type: query.subjectType as DecisionSubjectOption["type"] | undefined, id: query.subjectId, question: undefined as string | undefined, context: undefined as string | undefined }
  let revise: { expectedDecisionId: string; reason: string } | undefined
  if (query.reviseRequestId) {
    const previous = await prisma.reviewRequest.findFirst({ where: { id: query.reviseRequestId, workspaceId: workspace.id, gateType: "TRACKED_DECISION", state: "DECIDED" }, include: { currentRevision: { include: { decisions: { include: { option: true } } } } } })
    if (!previous?.currentRevision?.decisions[0]) notFound()
    const packet = JSON.parse(previous.currentRevision.packetJson) as { question: string; context: string; entity: { type: DecisionSubjectOption["type"]; id: string } }
    initial = { type: packet.entity.type, id: packet.entity.id, question: packet.question, context: packet.context }
    revise = { expectedDecisionId: previous.currentRevision.decisions[0].id, reason: previous.currentRevision.decisions[0].rationale ?? "Follow up on the previous decision." }
  }

  return <main className="space-y-6 p-6"><PageHeader title="New decision" description="Ask a clear question, link it to the work, and let an admin decide." /><NewDecisionForm workspaceId={workspace.id} orgSlug={orgSlug} workspaceSlug={workspaceSlug} subjects={subjects} initial={initial} revise={revise} /></main>
}
