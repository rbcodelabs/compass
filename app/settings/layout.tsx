import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { getUserWorkspaces } from "@/lib/workspace";
import { Sidebar } from "@/components/sidebar";
import { BottomNav } from "@/components/bottom-nav";
import { MobileHeader } from "@/components/mobile-header";
import { PanelProvider } from "@/components/panels/panel-context";
import { PanelShell } from "@/components/panels/panel-shell";
import { cookies } from "next/headers";
import { panelPinCookieName, parsePanelPin } from "@/lib/panel-pin";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

interface SettingsLayoutProps {
  children: React.ReactNode;
}

/**
 * Layout for the account-wide `/settings/*` routes (currently just
 * `/settings/agents`, "My agents"). Unlike every other authenticated route,
 * this one has no org or workspace segment in its URL, so with no
 * layout.tsx of its own it fell through to the bare root `app/layout.tsx`
 * and rendered with no Sidebar/BottomNav/MobileHeader chrome at all
 * (Compass feedback 4cb7d709-c580-44db-ac4b-e2edd1d4c9ed).
 *
 * Reuses the same Sidebar/BottomNav/MobileHeader chrome as the
 * `[orgSlug]/settings` layout, anchored on the caller's first workspace
 * membership *overall* (across all orgs, not scoped to one) purely for
 * nav-link targets — this page itself renders account-wide data, not
 * workspace data. `getUserWorkspaces()` already returns a stably ordered
 * list, so taking its first entry is a deterministic anchor.
 *
 * A user can reach this page with zero workspace memberships (agents are
 * owned by the user, not a workspace — see app/settings/agents/page.tsx),
 * so unlike the org-settings layout (which 404s with no workspace in that
 * org, because org membership implies workspace membership there) this
 * renders children directly with no forced redirect or 404 when there is no
 * workspace to anchor nav on.
 */
export default async function SettingsLayout({ children }: SettingsLayoutProps) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }

  const workspaces = await getUserWorkspaces(session.user.id);
  const anchorWorkspace = workspaces[0];

  if (!anchorWorkspace) {
    return <>{children}</>;
  }

  const cookieStore = await cookies();
  const sidebarDefaultOpen = cookieStore.get("sidebar_state")?.value !== "false";
  // Same server-seeded read as the workspace and org-settings layouts.
  const initialPanelPin = parsePanelPin(
    cookieStore.get(panelPinCookieName("detail"))?.value
  );

  return (
    // MobileHeader calls usePanelContext() unconditionally, so it needs a
    // PanelProvider ancestor here just like the workspace and org-settings
    // layouts provide. PanelShell is included for parity; the
    // discovery-rail panel MobileHeader can open is never reachable from
    // this account-scoped route, so it stays closed here.
    <PanelProvider orgSlug={anchorWorkspace.orgSlug} workspaceSlug={anchorWorkspace.slug}>
      <MobileHeader
        orgSlug={anchorWorkspace.orgSlug}
        workspaceSlug={anchorWorkspace.slug}
        workspaceName={anchorWorkspace.name}
        userName={session.user.name ?? session.user.email ?? ""}
        userEmail={session.user.email ?? ""}
        userImage={session.user.image ?? undefined}
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
            orgSlug={anchorWorkspace.orgSlug}
            workspaceSlug={anchorWorkspace.slug}
            workspaceName={anchorWorkspace.name}
            userName={session.user.name ?? session.user.email ?? ""}
            userEmail={session.user.email ?? ""}
            userImage={session.user.image ?? undefined}
            workspaces={workspaces}
          />

          <SidebarInset className="min-w-0 overflow-y-auto bg-surface-app pb-16 md:pb-0">
            {children}
          </SidebarInset>

          {/* Inside SidebarProvider, after SidebarInset — see the note in
              the workspace and org-settings layouts. */}
          <PanelShell initialPin={initialPanelPin} />
        </SidebarProvider>
      </TooltipProvider>

      <BottomNav orgSlug={anchorWorkspace.orgSlug} workspaceSlug={anchorWorkspace.slug} />
    </PanelProvider>
  );
}
