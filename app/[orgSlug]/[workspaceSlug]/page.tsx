import { redirect } from "next/navigation"
import { requireWorkspaceContext } from "@/lib/workspace-context"

interface WorkspaceIndexProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}

/** A workspace opens on its Home (the same widget board customers see in the portal). */
export default async function WorkspaceIndexPage({ params }: WorkspaceIndexProps) {
  const { orgSlug, workspaceSlug } = await params
  await requireWorkspaceContext(orgSlug, workspaceSlug)
  redirect(`/${orgSlug}/${workspaceSlug}/home`)
}
