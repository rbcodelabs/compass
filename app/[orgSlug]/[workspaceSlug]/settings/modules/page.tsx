import Link from "next/link"
import getPrisma from "@/lib/db"
import { PageHeader } from "@/components/patterns/page-header"
import { ModulesPanel } from "@/components/settings/modules-panel"
import { describeModules } from "@/lib/modules/server"
import { normalizeWorkspaceRole } from "@/lib/roles"
import { requireWorkspaceContext } from "@/lib/workspace-context"

export const metadata = { title: "Modules" }

export default async function ModulesSettingsPage({ params }: { params: Promise<{ orgSlug: string; workspaceSlug: string }> }) {
  const { orgSlug, workspaceSlug } = await params
  const { workspace, userId, isOrgAdmin, isReadOnly } = await requireWorkspaceContext(orgSlug, workspaceSlug)
  const member = await getPrisma().workspaceMember.findFirst({ where: { workspaceId: workspace.id, userId }, select: { role: true } })
  // Members can see what is on and why; only administrators can change it (the action re-checks).
  const canManage = !isReadOnly && (normalizeWorkspaceRole(member?.role) === "ADMIN" || isOrgAdmin)

  return (
    <main className="flex flex-1 flex-col gap-6 p-4 sm:p-6 md:p-8">
      <Link className="text-sm text-text-subtle underline" href={`/${orgSlug}/${workspaceSlug}/settings`}>Back to settings</Link>
      <PageHeader
        title="Modules"
        description={`Product modules for ${workspace.name}. A module that is off is hidden from the app and refused for people and agents alike.`}
      />
      <ModulesPanel orgSlug={orgSlug} workspaceSlug={workspaceSlug} canManage={canManage} initialModules={await describeModules(workspace.id)} />
    </main>
  )
}
