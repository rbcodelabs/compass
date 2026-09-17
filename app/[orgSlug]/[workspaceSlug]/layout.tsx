import { auth } from "@/auth"
import { redirect, notFound } from "next/navigation"
import { getWorkspace, getUserWorkspaces } from "@/lib/workspace"
import getPrisma from "@/lib/db"
import { Sidebar } from "@/components/sidebar"
import { BottomNav } from "@/components/bottom-nav"
import { MobileHeader } from "@/components/mobile-header"
import { PanelProvider } from "@/components/panels/panel-context"
import { PanelShell } from "@/components/panels/panel-shell"
import { WorkspaceThemeStyle } from "@/components/branding/workspace-theme-style"
import { resolveWorkspaceBranding } from "@/lib/branding"
import { cookies } from "next/headers"
import { panelPinCookieName, parsePanelPin } from "@/lib/panel-pin"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { isResearchCaptureEnabled } from "@/lib/research-feature"
import { ThemeProvider } from "@/components/theme/theme-provider"
import { workspaceThemeInitScript } from "@/lib/theme"

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

  const workspaces = await getUserWorkspaces(session.user.id)

  const prisma = getPrisma()
  const orgMembership = await prisma.organizationMember.findFirst({
    where: { organization: { slug: orgSlug }, userId: session.user.id },
    select: { role: true },
  })
  const isOrgAdmin = orgMembership?.role === "OWNER" || orgMembership?.role === "ADMIN"
  const cookieStore = await cookies()
  const sidebarDefaultOpen = cookieStore.get("sidebar_state")?.value !== "false"
  // Read beside sidebar_state, for the same reason: the detail panel's layout
  // has to be correct in the first painted frame, not corrected after
  // hydration. An absent or corrupt cookie parses to unpinned.
  const initialPanelPin = parsePanelPin(
    cookieStore.get(panelPinCookieName("detail"))?.value
  )
  const researchCaptureEnabled = isResearchCaptureEnabled()

  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: workspaceThemeInitScript }} />
      <WorkspaceThemeStyle branding={resolveWorkspaceBranding(workspace)} />
      <ThemeProvider>
        <div className="workspace-theme-scope contents">
        <PanelProvider orgSlug={orgSlug} workspaceSlug={workspaceSlug}>
        {/* Mobile header — shown on small screens only (hidden on md+) */}
        <MobileHeader
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          workspaceName={workspace.name}
          userName={session.user.name ?? session.user.email ?? ""}
          userEmail={session.user.email ?? ""}
          userImage={session.user.image ?? undefined}
          isOrgAdmin={isOrgAdmin}
        />

        <TooltipProvider>
          <SidebarProvider
            defaultOpen={sidebarDefaultOpen}
            className="h-[calc(100dvh-3.5rem)] min-h-0 overflow-hidden md:h-screen"
            style={{
              "--sidebar-width": "13.75rem",
              "--sidebar-width-icon": "3.5rem",
            } as React.CSSProperties}
          >
            <Sidebar
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              workspaceName={workspace.name}
              userName={session.user.name ?? session.user.email ?? ""}
              userEmail={session.user.email ?? ""}
              userImage={session.user.image ?? undefined}
              workspaces={workspaces}
              isOrgAdmin={isOrgAdmin}
              researchCaptureEnabled={researchCaptureEnabled}
            />

            {/* Main content — extra bottom padding on mobile to clear the fixed bottom nav */}
            <SidebarInset className="min-w-0 overflow-y-auto bg-surface-app pb-16 md:pb-0">
              {children}
            </SidebarInset>

            {/* Sits here, immediately after SidebarInset and inside
                SidebarProvider, because SidebarProvider renders a plain flex
                row — that is what makes a pinned panel a real third column
                beside main content rather than something floating over it. A
                no-op for overlay mode, which portals out of the tree either
                way. */}
            <PanelShell initialPin={initialPanelPin} />
          </SidebarProvider>
        </TooltipProvider>

        {/* Mobile bottom nav — shown on small screens only */}
        <BottomNav orgSlug={orgSlug} workspaceSlug={workspaceSlug} researchCaptureEnabled={researchCaptureEnabled} />
        </PanelProvider>
        </div>
      </ThemeProvider>
    </>
  )
}
