import { Suspense } from "react"
import Link from "next/link"
import type { ComponentType } from "react"
import { notFound, redirect } from "next/navigation"
import {
  Building2,
  CircleDashed,
  FileText,
  FlaskConical,
  Lightbulb,
  MapPinned,
  MessagesSquare,
  Wrench,
} from "lucide-react"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { getWorkspace } from "@/lib/workspace"
import { listTrackedDecisions, TRACKED_SUBJECT_LABELS, TRACKED_SUBJECT_TYPES, type TrackedSubjectType } from "@/lib/tracked-decisions"
import { WorkspacePage } from "@/components/patterns/workspace-page"
import { EmptyState } from "@/components/patterns/empty-state"
import { StatusBadge } from "@/components/patterns/status-badge"
import { RequestDecisionLink } from "@/components/decisions/request-decision-link"
import { DecisionsFilters } from "@/components/decisions/decisions-filters"
import { DecisionsTabs } from "@/components/decisions/decisions-tabs"
import { buttonVariants } from "@/components/ui/button"
import { isOrgAdminRole } from "@/lib/roles"

const LABELS: Record<string, string> = TRACKED_SUBJECT_LABELS

const SUBJECT_ICON: Record<TrackedSubjectType, ComponentType<{ className?: string }>> = {
  WORKSPACE: Building2,
  OPPORTUNITY: Lightbulb,
  SOLUTION: Wrench,
  ROADMAP_ITEM: MapPinned,
  DOC: FileText,
  EXPERIMENT: FlaskConical,
  FEEDBACK: MessagesSquare,
}

function subjectIcon(linkedType: string) {
  return SUBJECT_ICON[linkedType as TrackedSubjectType] ?? CircleDashed
}

function dateValue(value?: string, end = false) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const date = new Date(`${value}T${end ? "23:59:59.999" : "00:00:00.000"}Z`)
  return Number.isNaN(date.valueOf()) ? undefined : date
}

type TrackedDecisionListResult = Awaited<ReturnType<typeof listTrackedDecisions>>

function outcomeBadge(request: TrackedDecisionListResult["requests"][number]) {
  const decision = request.currentRevision?.decisions[0]
  if (!decision) {
    return (
      <StatusBadge status="neutral" icon={<CircleDashed />}>
        {request.state === "PENDING" ? "Awaiting review" : request.state}
      </StatusBadge>
    )
  }
  switch (decision.option.outcomeClass) {
    case "APPROVE":
      return <StatusBadge status="success">Approved</StatusBadge>
    case "REQUEST_CHANGES":
      return <StatusBadge status="warning">Changes requested</StatusBadge>
    case "REJECT":
      return <StatusBadge status="danger">Rejected</StatusBadge>
    default:
      return <StatusBadge status="neutral">{decision.option.label}</StatusBadge>
  }
}

export default async function DecisionsPage({ params, searchParams }: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const { orgSlug, workspaceSlug } = await params
  const query = await searchParams
  const session = await auth()
  if (!session?.user?.id) redirect("/login")
  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id)
  if (!workspace) notFound()
  const tab = query.tab === "decided" ? "DECIDED" : query.tab === "awaiting" ? "AWAITING_FOLLOW_THROUGH" : "PENDING"
  const subjectType = TRACKED_SUBJECT_TYPES.includes(query.type as TrackedSubjectType) ? query.type as TrackedSubjectType : undefined
  const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1)
  const result = await listTrackedDecisions({
    workspaceId: workspace.id, tab, subjectType,
    outcome: ["APPROVE", "REQUEST_CHANGES", "REJECT"].includes(query.outcome ?? "") ? query.outcome as "APPROVE" | "REQUEST_CHANGES" | "REJECT" : undefined,
    reviewerId: query.reviewer && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(query.reviewer) ? query.reviewer : undefined, query: query.q, from: dateValue(query.from), to: dateValue(query.to, true), page, pageSize: 20, includeLegacy: true,
  })
  const prisma = getPrisma()
  const [workspaceMembers, organizationAdmins] = await Promise.all([
    prisma.workspaceMember.findMany({ where: { workspaceId: workspace.id }, select: { userId: true, user: { select: { name: true, email: true } } }, orderBy: { user: { name: "asc" } } }),
    prisma.organizationMember.findMany({ where: { organizationId: workspace.organizationId }, select: { userId: true, role: true, user: { select: { name: true, email: true } } }, orderBy: { user: { name: "asc" } } }),
  ])
  const members = [...new Map([...workspaceMembers, ...organizationAdmins.filter((member) => isOrgAdminRole(member.role))].map((member) => [member.userId, member])).values()]
  const reviewerNames = new Map(members.map((member) => [member.userId, member.user.name ?? member.user.email]))
  const base = `/${orgSlug}/${workspaceSlug}/decisions`
  const paramsFor = (overrides: Record<string, string | undefined>) => {
    const next = new URLSearchParams(Object.entries({ ...query, ...overrides }).filter((entry): entry is [string, string] => Boolean(entry[1])))
    return `${base}?${next.toString()}`
  }

  return (
    <WorkspacePage
      title="Decisions"
      description="Request, review, and revisit product decisions in one place."
      actions={
        <Suspense>
          <DecisionsFilters reviewers={members.map((member) => ({ id: member.userId, name: member.user.name ?? member.user.email }))} />
          {/*
            The label collapses to the icon under `sm`, matching the Search /
            Date / Filters triggers beside it. WorkspacePage's header row does
            not wrap (`flex items-center justify-between`), so four
            always-labelled controls squeeze the "Decisions" <h1> — which is
            `min-w-0 truncate` — down to a few characters on a 390px phone.
          */}
          <RequestDecisionLink
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            label={<span className="hidden sm:inline">New decision</span>}
            ariaLabel="New decision"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          />
        </Suspense>
      }
    >
      <div className="flex flex-col gap-3 pb-4">
        <Suspense>
          <DecisionsTabs tab={tab} />
        </Suspense>

        {result.requests.length === 0 ? (
          <EmptyState
            title={tab === "PENDING" ? "No pending decisions" : tab === "DECIDED" ? "No decided decisions" : "Nothing awaiting follow-through"}
            description={
              tab === "PENDING" ? "Request a decision when the team needs a clear call, or clear your filters."
              : tab === "DECIDED" ? "Completed decisions will appear here."
              : "Every decided decision has either produced work or been explicitly closed as needing none."
            }
          />
        ) : (
          <div className="flex flex-col gap-2">
            {result.requests.map((request) => {
              const revision = request.currentRevision
              const decision = revision?.decisions[0]
              const legacy = request.gateType !== "TRACKED_DECISION"
              let linkedType: string = request.subjectType
              if (!legacy && revision?.packetJson) { try { linkedType = (JSON.parse(revision.packetJson) as { entity?: { type?: string } }).entity?.type ?? linkedType } catch {} }
              const Icon = subjectIcon(linkedType)
              return (
                <Link
                  key={request.id}
                  href={`/${orgSlug}/${workspaceSlug}/reviews/${request.id}`}
                  className="group flex flex-col gap-2 rounded-xl border border-border-default bg-surface-panel p-4 transition-colors hover:border-primary/40 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-inset text-text-subtle">
                      <Icon className="size-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-medium tracking-wide text-text-subtle uppercase">
                        {legacy ? "Legacy system decision" : LABELS[linkedType] ?? linkedType}
                      </p>
                      <h2 className="mt-0.5 truncate text-sm font-semibold text-text-primary">{revision?.title ?? "Decision"}</h2>
                      <p className="mt-1 line-clamp-2 text-sm text-text-secondary">{revision?.summary}</p>
                      <p className="mt-2 text-xs text-text-subtle">
                        Updated {request.updatedAt.toLocaleDateString()}
                        {decision ? ` • ${reviewerNames.get(decision.actorUserId) ?? "Workspace admin"}` : ""}
                      </p>
                    </div>
                  </div>
                  <div className="shrink-0 pl-11 sm:pl-0">{outcomeBadge(request)}</div>
                </Link>
              )
            })}
          </div>
        )}

        {result.pageCount > 1 && (
          <nav className="flex items-center justify-between text-sm" aria-label="Decision pages">
            <span className="text-text-subtle">Page {result.page} of {result.pageCount}</span>
            <div className="flex gap-2">
              {result.page > 1 && <Link className="rounded-md border px-3 py-2" href={paramsFor({ page: String(result.page - 1) })}>Previous</Link>}
              {result.page < result.pageCount && <Link className="rounded-md border px-3 py-2" href={paramsFor({ page: String(result.page + 1) })}>Next</Link>}
            </div>
          </nav>
        )}
      </div>
    </WorkspacePage>
  )
}
