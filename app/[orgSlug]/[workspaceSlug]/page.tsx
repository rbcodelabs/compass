import { redirect } from "next/navigation"
import getPrisma from "@/lib/db"
import { workspaceUpdatesAvailable } from "@/lib/workspace-updates-capture"

interface WorkspaceIndexProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}

export default async function WorkspaceIndexPage({ params }: WorkspaceIndexProps) {
  const { orgSlug, workspaceSlug } = await params
  const enabled = await workspaceUpdatesAvailable(getPrisma())
  redirect(`/${orgSlug}/${workspaceSlug}/${enabled ? "updates" : "okrs"}`)
}
