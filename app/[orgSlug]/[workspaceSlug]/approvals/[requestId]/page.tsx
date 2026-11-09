import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { isWorkspaceAdminUser } from "@/lib/agent-ownership"
import { loadApprovalView } from "@/lib/tool-approval/view"
import { ApprovalActions, RefreshWhile } from "@/components/tool-approval/approval-actions"
import { ApprovalDetail, OutcomeBox } from "@/components/tool-approval/approval-detail"
import { decideApprovalAction } from "../actions"

export const metadata = { title: "Tool approval" }

export default async function ToolApprovalPage({ params }: { params: Promise<{ orgSlug: string; workspaceSlug: string; requestId: string }> }) {
  const { orgSlug, workspaceSlug, requestId } = await params
  const session = await auth()
  if (!session?.user?.id) redirect("/login")
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findFirst({ where: { slug: workspaceSlug, organization: { slug: orgSlug } }, select: { id: true } })
  // Same answer as the generic review page: anyone who is not a workspace or organization admin gets a plain 404, so the
  // existence of an approval, and everything in it, stays with the people who can act on it.
  if (!workspace || !(await isWorkspaceAdminUser(prisma, session.user.id, workspace.id))) notFound()
  const view = await loadApprovalView(prisma, { requestId, workspaceId: workspace.id })
  if (!view) notFound()

  const pending = view.state.key === "PENDING"
  return (
    <main className="mx-auto w-full min-w-0 max-w-3xl space-y-6 overflow-x-hidden p-4 sm:p-6">
      <ApprovalDetail view={view} />
      {pending ? (
        <section aria-label="Decide" className="min-w-0 space-y-3 rounded-lg border border-border-default bg-surface-panel p-4">
          <h2 className="m-0 text-lg font-semibold">Decide</h2>
          <p className="m-0 text-sm text-text-secondary">Approving runs the change above once, as you. Denying runs nothing.</p>
          <ApprovalActions decide={decideApprovalAction.bind(null, { orgSlug, workspaceSlug, requestId: view.requestId })} />
        </section>
      ) : (
        <OutcomeBox view={view} />
      )}
      <RefreshWhile active={view.state.key === "APPLYING"} />
    </main>
  )
}
