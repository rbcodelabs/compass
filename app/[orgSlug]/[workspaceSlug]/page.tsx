import { redirect } from "next/navigation"

interface WorkspaceIndexProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}

export default async function WorkspaceIndexPage({ params }: WorkspaceIndexProps) {
  const { orgSlug, workspaceSlug } = await params
  redirect(`/${orgSlug}/${workspaceSlug}/okrs`)
}
