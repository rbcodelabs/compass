import { redirect } from "next/navigation"
import getPrisma from "@/lib/db"
import { requireWorkspaceContext } from "@/lib/workspace-context"
import { workspaceUpdatesAvailable } from "@/lib/workspace-updates-capture"

interface WorkspaceIndexProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}

export default async function WorkspaceIndexPage({ params }: WorkspaceIndexProps) {
  const { orgSlug, workspaceSlug } = await params
  const { workspace } = await requireWorkspaceContext(orgSlug, workspaceSlug)
  const enabled = await workspaceUpdatesAvailable(getPrisma(), workspace.id)
  redirect(`/${orgSlug}/${workspaceSlug}/${enabled ? "updates" : "okrs"}`)
}
