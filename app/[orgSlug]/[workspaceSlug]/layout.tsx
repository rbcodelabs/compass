import { auth } from "@/auth"
import { redirect, notFound } from "next/navigation"
import { getWorkspace, getOrgWorkspaces } from "@/lib/workspace"
import { Sidebar } from "@/components/sidebar"
import { BottomNav } from "@/components/bottom-nav"
import { MobileHeader } from "@/components/mobile-header"
import { PanelProvider } from "@/components/panels/panel-context"
import { PanelShell } from "@/components/panels/panel-shell"

interface WorkspaceLayoutProps {
  children: React.ReactNode
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}

export default async function WorkspaceLayout({
  children,
  params,
}: WorkspaceLayoutProps) {
  const session = await auth()
  if (!session?.user?.id) {
    redirect("/login")
  }

  const { orgSlug, workspaceSlug } = await params

  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id)
  if (!workspace) {
    notFound()
  }

  const workspaces = await getOrgWorkspaces(orgSlug, session.user.id)

  return (
    <PanelProvider orgSlug={orgSlug} workspaceSlug={workspaceSlug}>
      {/* Mobile header — shown on small screens only (hidden on md+) */}
      <MobileHeader
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        workspaceName={workspace.name}
      />

      {/* On mobile: subtract the 56px header height so the content area fills the rest */}
      <div className="flex h-[calc(100dvh-3.5rem)] md:h-screen overflow-hidden">
        {/* Desktop sidebar — hidden on mobile via sidebar.tsx */}
        <Sidebar
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          workspaceName={workspace.name}
          userName={session.user.name ?? session.user.email ?? ""}
          userImage={session.user.image ?? undefined}
          workspaces={workspaces}
        />

        {/* Main content — extra bottom padding on mobile to clear the fixed bottom nav */}
        <main className="flex-1 overflow-y-auto bg-slate-50 pb-16 md:pb-0">
          {children}
        </main>
      </div>

      {/* Mobile bottom nav — shown on small screens only */}
      <BottomNav orgSlug={orgSlug} workspaceSlug={workspaceSlug} />

      <PanelShell />
    </PanelProvider>
  )
}
