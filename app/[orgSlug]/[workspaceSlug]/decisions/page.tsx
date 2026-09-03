import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { getWorkspace } from "@/lib/workspace"
import { listTrackedDecisions, TRACKED_SUBJECT_TYPES, type TrackedSubjectType } from "@/lib/tracked-decisions"
import { PageHeader } from "@/components/patterns/page-header"
import { RequestDecisionLink } from "@/components/decisions/request-decision-link"

const LABELS: Record<string, string> = { WORKSPACE: "Workspace", OPPORTUNITY: "Opportunity", SOLUTION: "Solution", ROADMAP_ITEM: "Roadmap Item", DOC: "Doc", EXPERIMENT: "Experiment", FEEDBACK: "Feedback" }

function dateValue(value?: string, end = false) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const date = new Date(`${value}T${end ? "23:59:59.999" : "00:00:00.000"}Z`)
  return Number.isNaN(date.valueOf()) ? undefined : date
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
  const tab = query.tab === "decided" ? "DECIDED" : "PENDING"
  const subjectType = TRACKED_SUBJECT_TYPES.includes(query.type as TrackedSubjectType) ? query.type as TrackedSubjectType : undefined
  const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1)
  const result = await listTrackedDecisions({
    workspaceId: workspace.id, tab, subjectType,
    outcome: ["APPROVE", "REQUEST_CHANGES", "REJECT"].includes(query.outcome ?? "") ? query.outcome as "APPROVE" | "REQUEST_CHANGES" | "REJECT" : undefined,
    reviewerId: query.reviewer || undefined, query: query.q, from: dateValue(query.from), to: dateValue(query.to, true), page, pageSize: 20,
  })
  const members = await getPrisma().workspaceMember.findMany({ where: { workspaceId: workspace.id }, select: { userId: true, user: { select: { name: true, email: true } } }, orderBy: { user: { name: "asc" } } })
  const reviewerNames = new Map(members.map((member) => [member.userId, member.user.name ?? member.user.email]))
  const base = `/${orgSlug}/${workspaceSlug}/decisions`
  const paramsFor = (overrides: Record<string, string | undefined>) => {
    const next = new URLSearchParams(Object.entries({ ...query, ...overrides }).filter((entry): entry is [string, string] => Boolean(entry[1])))
    return `${base}?${next.toString()}`
  }

  return <main className="space-y-6 p-6">
    <PageHeader title="Decisions" description="Request, review, and revisit product decisions in one place." actions={<RequestDecisionLink orgSlug={orgSlug} workspaceSlug={workspaceSlug} label="New decision" />} />
    <div className="flex gap-2 border-b"><Link className={`px-3 py-2 text-sm ${tab === "PENDING" ? "border-b-2 border-primary font-medium" : "text-muted-foreground"}`} href={paramsFor({ tab: "pending", page: undefined })}>Pending</Link><Link className={`px-3 py-2 text-sm ${tab === "DECIDED" ? "border-b-2 border-primary font-medium" : "text-muted-foreground"}`} href={paramsFor({ tab: "decided", page: undefined })}>Decided</Link></div>
    <form className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-6">
      <input type="hidden" name="tab" value={tab.toLowerCase()} />
      <input className="rounded-md border bg-background px-3 py-2 text-sm lg:col-span-2" name="q" defaultValue={query.q} placeholder="Search decisions" />
      <select className="rounded-md border bg-background px-3 py-2 text-sm" name="type" defaultValue={query.type ?? ""}><option value="">All linked items</option>{TRACKED_SUBJECT_TYPES.map((type) => <option key={type} value={type}>{LABELS[type]}</option>)}</select>
      <select className="rounded-md border bg-background px-3 py-2 text-sm" name="outcome" defaultValue={query.outcome ?? ""}><option value="">All outcomes</option><option value="APPROVE">Approved</option><option value="REQUEST_CHANGES">Changes requested</option><option value="REJECT">Rejected</option></select>
      <select className="rounded-md border bg-background px-3 py-2 text-sm" name="reviewer" defaultValue={query.reviewer ?? ""}><option value="">All reviewers</option>{members.map((member) => <option key={member.userId} value={member.userId}>{member.user.name ?? member.user.email}</option>)}</select>
      <button className="rounded-md border px-3 py-2 text-sm font-medium" type="submit">Filter</button>
      <input className="rounded-md border bg-background px-3 py-2 text-sm" type="date" name="from" aria-label="From date" defaultValue={query.from} />
      <input className="rounded-md border bg-background px-3 py-2 text-sm" type="date" name="to" aria-label="To date" defaultValue={query.to} />
    </form>
    {result.requests.length === 0 ? <section className="rounded-xl border border-dashed p-10 text-center"><h2 className="font-semibold">No {tab.toLowerCase()} decisions</h2><p className="mt-1 text-sm text-muted-foreground">{tab === "PENDING" ? "Request a decision when the team needs a clear call." : "Completed decisions will appear here."}</p></section> : <div className="space-y-3">{result.requests.map((request) => {
      const revision = request.currentRevision
      const decision = revision?.decisions[0]
      const legacy = request.gateType !== "TRACKED_DECISION"
      return <Link key={request.id} href={`/${orgSlug}/${workspaceSlug}/reviews/${request.id}`} className="block rounded-xl border bg-card p-4 hover:border-primary/40">
        <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{legacy ? "Legacy system decision" : LABELS[request.subjectType] ?? request.subjectType}</p><h2 className="mt-1 font-semibold">{revision?.title ?? "Decision"}</h2><p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{revision?.summary}</p></div><span className="rounded-full bg-muted px-2 py-1 text-xs">{decision?.option.label ?? request.state}</span></div>
        <p className="mt-3 text-xs text-muted-foreground">Updated {request.updatedAt.toLocaleDateString()} {decision ? `• ${reviewerNames.get(decision.actorUserId) ?? "Workspace admin"}` : ""}</p>
      </Link>
    })}</div>}
    {result.pageCount > 1 && <nav className="flex items-center justify-between text-sm" aria-label="Decision pages"><span>Page {result.page} of {result.pageCount}</span><div className="flex gap-2">{result.page > 1 && <Link className="rounded-md border px-3 py-2" href={paramsFor({ page: String(result.page - 1) })}>Previous</Link>}{result.page < result.pageCount && <Link className="rounded-md border px-3 py-2" href={paramsFor({ page: String(result.page + 1) })}>Next</Link>}</div></nav>}
  </main>
}
