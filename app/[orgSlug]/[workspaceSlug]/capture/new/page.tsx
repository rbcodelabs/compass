import { PageHeader } from "@/components/patterns/page-header"
import { StudyBuilder } from "@/components/research/study-builder"
import { createResearchStudy, generateUsabilityTasks } from "../actions"
import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { isResearchCaptureEnabled } from "@/lib/research-feature"

export default async function NewStudyPage({ params }: { params: Promise<{ orgSlug: string; workspaceSlug: string }> }) {
  if (!isResearchCaptureEnabled()) notFound()
  const session = await auth()
  if (!session?.user?.id) redirect("/login")
  const { orgSlug, workspaceSlug } = await params
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug }, members: { some: { userId: session.user.id } } },
    select: { id: true },
  })
  if (!workspace) notFound()
  const action = createResearchStudy.bind(null, orgSlug, workspaceSlug)
  const taskAction = generateUsabilityTasks.bind(null, orgSlug, workspaceSlug)

  return (
    <main className="flex flex-1 flex-col gap-6 p-4 sm:p-6 md:p-8">
      <PageHeader
        title="New research study"
        description="Create a customer interview or guided usability test with chat and voice."
      />
      <StudyBuilder action={action} generateTasks={taskAction} />
    </main>
  )
}
