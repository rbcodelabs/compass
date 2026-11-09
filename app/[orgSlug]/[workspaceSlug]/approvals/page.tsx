import type { ReactNode } from "react"
import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { isWorkspaceAdminUser } from "@/lib/agent-ownership"
import { listPendingToolApprovals } from "@/lib/tool-approval/request"
import { loadRecentApprovals } from "@/lib/tool-approval/view"
import { toolApprovalPath } from "@/lib/tool-approval/gate"
import { EmptyState } from "@/components/patterns/empty-state"
import { WorkspacePage } from "@/components/patterns/workspace-page"
import { ApprovalStateBadge } from "@/components/tool-approval/approval-state-badge"
import { formatWhen } from "@/components/tool-approval/approval-detail"

export const metadata = { title: "Tool approvals" }

type Row = { id: string; displayId: string | null; href: string; title: string; summary: string; tool: string; when: string; badge: ReactNode }

function ApprovalRow({ row }: { row: Row }) {
  return (
    <li className="min-w-0">
      <Link
        href={row.href}
        className="flex min-h-11 min-w-0 flex-col gap-2 rounded-xl border border-border-default bg-surface-panel p-4 transition-colors hover:border-primary/40 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
      >
        <div className="min-w-0">
          <p className="m-0 text-xs font-medium text-text-subtle">{row.displayId ?? "Tool approval"} · <code className="font-mono">{row.tool}</code></p>
          <h2 className="m-0 mt-0.5 text-sm font-semibold break-words text-text-primary [overflow-wrap:anywhere]">{row.title}</h2>
          {row.summary && <p className="m-0 mt-1 line-clamp-2 text-sm break-words text-text-secondary [overflow-wrap:anywhere]">{row.summary}</p>}
          <p className="m-0 mt-2 text-xs text-text-subtle">{row.when}</p>
        </div>
        <div className="shrink-0">{row.badge}</div>
      </Link>
    </li>
  )
}

export default async function ToolApprovalsPage({ params }: { params: Promise<{ orgSlug: string; workspaceSlug: string }> }) {
  const { orgSlug, workspaceSlug } = await params
  const session = await auth()
  if (!session?.user?.id) redirect("/login")
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findFirst({ where: { slug: workspaceSlug, organization: { slug: orgSlug } }, select: { id: true } })
  if (!workspace || !(await isWorkspaceAdminUser(prisma, session.user.id, workspace.id))) notFound()

  const [pending, recent] = await Promise.all([
    listPendingToolApprovals(workspace.id, { userId: session.user.id }),
    loadRecentApprovals(prisma, workspace.id),
  ])
  const pendingRows: Row[] = pending.map((item) => ({
    id: item.requestId, displayId: item.displayId, href: toolApprovalPath(orgSlug, workspaceSlug, item.requestId), title: item.title, summary: item.summary, tool: item.tool,
    when: `Requested ${formatWhen(item.createdAt.toISOString())}${item.expiresAt ? ` · expires ${formatWhen(item.expiresAt.toISOString())}` : ""}`,
    badge: <ApprovalStateBadge state="PENDING" />,
  }))
  const recentRows: Row[] = recent.map((view) => ({
    id: view.requestId, displayId: view.displayId, href: toolApprovalPath(orgSlug, workspaceSlug, view.requestId), title: view.title, summary: view.summary, tool: view.tool,
    when: view.decision ? `${view.decision.approved ? "Approved" : "Denied"} ${formatWhen(view.decision.decidedAt)}${view.decision.decidedByName ? ` by ${view.decision.decidedByName}` : ""}` : `Requested ${formatWhen(view.createdAt)}`,
    badge: <ApprovalStateBadge state={view.state.key} />,
  }))

  return (
    <WorkspacePage title="Tool approvals" description="Actions an agent or integration asked to take that need a workspace admin's approval first.">
      <div className="flex min-w-0 flex-col gap-8 pb-4">
        <section aria-label="Waiting for approval" className="min-w-0 space-y-3">
          <h2 className="m-0 text-base font-semibold">Waiting for approval <span className="font-normal text-text-subtle">{pendingRows.length}</span></h2>
          {pendingRows.length === 0
            ? <EmptyState compact title="Nothing is waiting" description="When a tool needs approval before it runs, the request appears here." />
            : <ul className="m-0 flex list-none flex-col gap-2 p-0">{pendingRows.map((row) => <ApprovalRow key={row.id} row={row} />)}</ul>}
        </section>
        <section aria-label="Recently decided" className="min-w-0 space-y-3">
          <h2 className="m-0 text-base font-semibold">Recently decided</h2>
          {recentRows.length === 0
            ? <p className="m-0 text-sm text-text-subtle">No approvals have been decided yet.</p>
            : <ul className="m-0 flex list-none flex-col gap-2 p-0">{recentRows.map((row) => <ApprovalRow key={row.id} row={row} />)}</ul>}
        </section>
      </div>
    </WorkspacePage>
  )
}
