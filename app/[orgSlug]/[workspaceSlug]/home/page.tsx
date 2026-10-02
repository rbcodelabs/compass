import getPrisma from "@/lib/db"
import { requireWorkspaceContext } from "@/lib/workspace-context"
import { isPermissionError, resolveWorkspaceAdmin } from "@/lib/permissions"
import { EmptyHome, PortalHomeBoard } from "@/components/portal-home/board"
import { PortalHomeEditor } from "@/components/portal-home/editor"
import { buildDefaultWidgets } from "@/lib/portal-home/defaults"
import { resolveHomeForMember, resolveHomeForTeam } from "@/lib/portal-home/resolve"
import { loadHomeLayout, loadPublishedWidgets } from "@/lib/portal-home/service"

export const metadata = {
  title: "Home",
}

interface TeamHomePageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}

async function isHomeAdmin(orgSlug: string, workspaceSlug: string): Promise<boolean> {
  try {
    await resolveWorkspaceAdmin(orgSlug, workspaceSlug)
    return true
  } catch (error) {
    if (isPermissionError(error)) return false
    throw error
  }
}

/**
 * Team view of Portal Home: the same single layout customers see at
 * /portal/[org]/[ws], rendered for workspace members. Members also see
 * widgets set to "Team only" and Doc links.
 *
 * Access: requireWorkspaceContext is the same membership gate the workspace
 * layout and every sibling page use (signed-out -> /login, non-member -> 404).
 * It also admits org members with read-only access, who may view but not edit:
 * the editor below is gated on resolveWorkspaceAdmin, which needs a real
 * workspace membership. The board reads the PUBLISHED layout only; the draft is
 * reachable solely through the admin editor (its Edit/Preview modes).
 */
export default async function TeamHomePage({ params }: TeamHomePageProps) {
  const { orgSlug, workspaceSlug } = await params
  const { workspace } = await requireWorkspaceContext(orgSlug, workspaceSlug)
  const prisma = getPrisma()

  const roadmapPublic = workspace.roadmapPublic === true
  const feedbackEnabled = workspace.feedbackEnabled === true
  const resolveContext = {
    prisma,
    workspace: { id: workspace.id, orgSlug, workspaceSlug, roadmapPublic, feedbackEnabled },
  }
  const defaults = buildDefaultWidgets({ workspaceName: workspace.name, orgSlug, workspaceSlug, roadmapPublic, feedbackEnabled })

  const published = await loadPublishedWidgets(prisma, workspace.id)
  const baseline = published ?? defaults
  const home = await resolveHomeForTeam(resolveContext, baseline)
  const board =
    home.widgets.length > 0 ? (
      <PortalHomeBoard widgets={home.widgets} resolved={home.resolved} />
    ) : (
      <EmptyHome>Nothing on the team home yet.</EmptyHome>
    )

  if (!(await isHomeAdmin(orgSlug, workspaceSlug))) {
    return <div className="mx-auto w-full max-w-6xl p-4 md:p-6">{board}</div>
  }

  const layout = await loadHomeLayout(prisma, workspace.id)
  const draft = layout.hasRow ? layout.draft : defaults
  const initialResolved = await resolveHomeForMember(resolveContext, draft)

  return (
    <div className="mx-auto w-full max-w-6xl p-4 md:p-6">
      <PortalHomeEditor
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        initialDraft={draft}
        initialBaseline={baseline}
        publishedAt={layout.publishedAt?.toISOString() ?? null}
        initialResolved={initialResolved}
      >
        {board}
      </PortalHomeEditor>
    </div>
  )
}
