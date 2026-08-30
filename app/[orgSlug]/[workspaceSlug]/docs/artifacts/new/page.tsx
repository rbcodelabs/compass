import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { notFound, redirect } from "next/navigation"
import { ArtifactCreateForm } from "@/components/docs/artifact-create-form"

export default async function NewArtifactPage({ params }: { params: Promise<{ orgSlug: string; workspaceSlug: string }> }) {
  const session = await auth()
  if (!session?.user?.id) redirect("/login")
  const { orgSlug, workspaceSlug } = await params
  const workspace = await getPrisma().workspace.findFirst({ where: { slug: workspaceSlug, organization: { slug: orgSlug }, members: { some: { userId: session.user.id } } }, select: { id: true } })
  if (!workspace) notFound()
  const basePath = `/${orgSlug}/${workspaceSlug}/docs`
  return <div className="mx-auto max-w-2xl p-4 sm:p-8"><h1 className="text-2xl font-semibold mb-2">New artifact</h1><p className="text-sm text-text-secondary mb-6">Add a self-contained HTML prototype or link to an externally hosted artifact.</p><ArtifactCreateForm workspaceId={workspace.id} basePath={basePath} /></div>
}
