import { redirect } from "next/navigation"
import { getUserWorkspaces } from "@/lib/workspace"
import { requireWorkspaceContext } from "@/lib/workspace-context"
import { getSessionUser } from "@/lib/session"
import { Sidebar } from "@/components/sidebar"
import { BottomNav } from "@/components/bottom-nav"
import { MobileHeader } from "@/components/mobile-header"
import { PanelProvider } from "@/components/panels/panel-context"
import { PanelShell } from "@/components/panels/panel-shell"
import { AgentRailProvider } from "@/components/agent/agent-rail-context"
import { AgentRail } from "@/components/agent/agent-rail"
import { initialsOf } from "@/lib/user-initials"
import { WorkspaceThemeStyle } from "@/components/branding/workspace-theme-style"
import { resolveWorkspaceBranding } from "@/lib/branding"
import { cookies } from "next/headers"
import { panelPinCookieName, parsePanelPin } from "@/lib/panel-pin"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { isResearchCaptureEnabled } from "@/lib/research-feature"
import { ThemeProvider } from "@/components/theme/theme-provider"
import { workspaceThemeInitScript } from "@/lib/theme"
import getPrisma from "@/lib/db"
import { workspaceUpdatesAvailable } from "@/lib/workspace-updates-capture"

interface WorkspaceLayoutProps {
  children: React.ReactNode
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}

export default async function WorkspaceLayout({
  children,
  params,
}: WorkspaceLayoutProps) {
  const { orgSlug, workspaceSlug } = await params

  // Phase 1: the session is the only thing nothing else can start without.
  const user = await getSessionUser()
  if (!user) {
    redirect("/login")
  }

  // Phase 2: three independent reads. requireWorkspaceContext's own
  // getSessionUser() call resolves from the request memo rather than issuing a
  // second session lookup — that memoization is what makes hoisting it into
  // this Promise.all safe.
  const [ctx, workspaces, cookieStore] = await Promise.all([
    requireWorkspaceContext(orgSlug, workspaceSlug),
    getUserWorkspaces(user.id),
    cookies(),
  ])
  const { workspace, isOrgAdmin } = ctx
  const sidebarDefaultOpen = cookieStore.get("sidebar_state")?.value !== "false"
  // Read beside sidebar_state, for the same reason: the detail panel's layout
  // has to be correct in the first painted frame, not corrected after
  // hydration. An absent or corrupt cookie parses to unpinned.
  const initialPanelPin = parsePanelPin(
    cookieStore.get(panelPinCookieName("detail"))?.value
  )
  // Same contract again for the agent rail, where `pinned` means "docked open".
  // Seeding it here is what lets a returning user's rail be present in the first
  // painted frame — and, more importantly, lets AgentRail measure the real
  // layout before paint instead of after.
  const initialAgentPin = parsePanelPin(
    cookieStore.get(panelPinCookieName("agent"))?.value
  )
  const researchCaptureEnabled = isResearchCaptureEnabled()
  const updatesEnabled = await workspaceUpdatesAvailable(getPrisma())

  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: workspaceThemeInitScript }} />
      <WorkspaceThemeStyle branding={resolveWorkspaceBranding(workspace)} />
      <ThemeProvider>
        <div className="workspace-theme-scope contents">
        <PanelProvider orgSlug={orgSlug} workspaceSlug={workspaceSlug}>
        {/* Inside PanelProvider, because the rail measures around the detail
            panel and so reads that context; and at layout level rather than
            inside a page, because the layout is the only thing that survives
            navigation between workspace screens — which is the entire point of
            the rail over the full-page agent screen. A streaming turn keeps
            streaming while the user moves to the Roadmap. */}
        <AgentRailProvider initialPin={initialAgentPin}>
        {/* Mobile header — shown on small screens only (hidden on md+) */}
        <MobileHeader
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          workspaceName={workspace.name}
          userName={user.name ?? user.email ?? ""}
          userEmail={user.email ?? ""}
          userImage={user.image ?? undefined}
          isOrgAdmin={isOrgAdmin}
        />

        <TooltipProvider>
          <SidebarProvider
            defaultOpen={sidebarDefaultOpen}
            // `relative` is here for the agent rail's overlay mode, which
            // positions itself `absolute` against this wrapper (offset by the
            // live nav width) when there is not enough room to dock it as a
            // column. Without it the rail would resolve against the viewport
            // and sit under the nav. It changes nothing else: every other
            // absolutely positioned descendant already resolves against a
            // closer positioned ancestor (SidebarInset, or the fixed sidebar
            // container), and `relative` does not capture `fixed` children.
            className="relative h-[calc(100dvh-3.5rem)] min-h-0 overflow-hidden md:h-screen"
            style={{
              "--sidebar-width": "13.75rem",
              "--sidebar-width-icon": "3.5rem",
            } as React.CSSProperties}
          >
            <Sidebar
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              workspaceName={workspace.name}
              userName={user.name ?? user.email ?? ""}
              userEmail={user.email ?? ""}
              userImage={user.image ?? undefined}
              workspaces={workspaces}
              isOrgAdmin={isOrgAdmin}
              researchCaptureEnabled={researchCaptureEnabled}
              updatesEnabled={updatesEnabled}
            />

            {/* Between the nav and main content, so the docked rail is a real
                second column in the same flex row — main content yields to it
                rather than scrolling under it. The detail panel stays where it
                is, on the far right, which is the constraint that put the agent
                on this side in the first place. */}
            <AgentRail
              workspaceId={workspace.id}
              basePath={`/${orgSlug}/${workspaceSlug}`}
              userInitials={initialsOf(user.name ?? user.email)}
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
        <BottomNav orgSlug={orgSlug} workspaceSlug={workspaceSlug} researchCaptureEnabled={researchCaptureEnabled} updatesEnabled={updatesEnabled} />
        </AgentRailProvider>
        </PanelProvider>
        </div>
      </ThemeProvider>
    </>
  )
}
