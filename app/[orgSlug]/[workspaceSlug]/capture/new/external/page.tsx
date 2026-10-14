import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { PageHeader } from "@/components/patterns/page-header"
import { ExternalStudyForm } from "@/components/research/external-study-form"
import { isResearchCaptureEnabled } from "@/lib/research-feature"
import { createExternalResearchStudy } from "../../actions"

export const metadata = { title: "New external study" }

export default async function NewExternalStudyPage({ params }: { params: Promise<{ orgSlug: string; workspaceSlug: string }> }) {
  if (!isResearchCaptureEnabled()) notFound()
  const session = await auth()
  if (!session?.user?.id) redirect("/login")
  const { orgSlug, workspaceSlug } = await params
  const workspace = await getPrisma().workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug }, members: { some: { userId: session.user.id } } },
    select: { id: true },
  })
  if (!workspace) notFound()
  return (
    <main className="flex flex-1 flex-col gap-6 p-4 sm:p-6 md:p-8">
      <PageHeader title="New manual / external study" description="Record research that was run outside Compass so its findings can become evidence." />
      <ExternalStudyForm action={createExternalResearchStudy.bind(null, orgSlug, workspaceSlug)} />
    </main>
  )
}
