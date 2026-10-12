import { redirect, notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getUserWorkspaces } from "@/lib/workspace";
import { getSessionUser } from "@/lib/session";
import { resolveRoadmapViewActor } from "@/lib/roadmap-views/service";
import { Sidebar } from "@/components/sidebar";
import { BottomNav } from "@/components/bottom-nav";
import { MobileHeader } from "@/components/mobile-header";
import { PanelProvider } from "@/components/panels/panel-context";
import { PanelShell } from "@/components/panels/panel-shell";
import { panelPinCookieName, parsePanelPin } from "@/lib/panel-pin";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

interface OrgRoadmapLayoutProps {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}

/**
 * Layout for the cross-workspace roadmap (/{orgSlug}/roadmap).
 *
 * Same chrome as the org settings route (see app/[orgSlug]/settings/layout.tsx):
 * the sidebar is anchored to the caller's first workspace in this org purely for
 * nav-link targets, because this page itself renders data from many workspaces.
 *
 * Unlike settings, this is NOT admin-gated: any user who can reach at least one
 * workspace in the org may open it. What they see is limited to the workspaces
 * they can read (resolveRoadmapViewActor -> getUserWorkspaces). A user with no
 * reachable workspace gets a 404, which also hides the org's existence.
 */
export default async function OrgRoadmapLayout({ children, params }: OrgRoadmapLayoutProps) {
  const { orgSlug } = await params;

  const user = await getSessionUser();
  if (!user) redirect("/login");

  const [actor, workspaces] = await Promise.all([
    resolveRoadmapViewActor(user.id, orgSlug),
    getUserWorkspaces(user.id),
  ]);
  if (!actor) notFound();

  const anchorWorkspace = workspaces.find((ws) => ws.orgSlug === orgSlug);
  if (!anchorWorkspace) notFound();

  const cookieStore = await cookies();
  const sidebarDefaultOpen = cookieStore.get("sidebar_state")?.value !== "false";
  const initialPanelPin = parsePanelPin(cookieStore.get(panelPinCookieName("detail"))?.value);

  return (
    <PanelProvider orgSlug={orgSlug} workspaceSlug={anchorWorkspace.slug}>
      <MobileHeader
        orgSlug={orgSlug}
        workspaceSlug={anchorWorkspace.slug}
        workspaceName={anchorWorkspace.name}
        userName={user.name ?? user.email ?? ""}
        userEmail={user.email ?? ""}
        userImage={user.image ?? undefined}
        showOrgRoadmap
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
            workspaceSlug={anchorWorkspace.slug}
            workspaceName={anchorWorkspace.name}
            userName={user.name ?? user.email ?? ""}
            userEmail={user.email ?? ""}
            userImage={user.image ?? undefined}
            workspaces={workspaces}
            isOrgAdmin={actor.isOrgAdmin}
          />

          <SidebarInset className="min-w-0 overflow-y-auto bg-surface-app pb-16 md:pb-0">
            {children}
          </SidebarInset>

          <PanelShell initialPin={initialPanelPin} />
        </SidebarProvider>
      </TooltipProvider>

      <BottomNav orgSlug={orgSlug} workspaceSlug={anchorWorkspace.slug} />
    </PanelProvider>
  );
}
