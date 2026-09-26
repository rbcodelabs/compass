import { redirect, notFound } from "next/navigation";
import { getUserWorkspaces } from "@/lib/workspace";
import { getSessionUser } from "@/lib/session";
import { isOrgAdminRole } from "@/lib/roles";
import getPrisma from "@/lib/db";
import { Sidebar } from "@/components/sidebar";
import { BottomNav } from "@/components/bottom-nav";
import { MobileHeader } from "@/components/mobile-header";
import { PanelProvider } from "@/components/panels/panel-context";
import { PanelShell } from "@/components/panels/panel-shell";
import { cookies } from "next/headers";
import { panelPinCookieName, parsePanelPin } from "@/lib/panel-pin";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

interface OrgSettingsLayoutProps {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}

/**
 * Layout for the org-level settings route (/{orgSlug}/settings) — the first
 * org-scoped (not workspace-scoped) route in the app. Reuses the same
 * Sidebar/BottomNav/MobileHeader chrome as workspace pages, anchored to the
 * caller's first workspace membership in this org purely for nav-link
 * targets (Discovery, OKRs, etc.) — this page itself renders org-wide data,
 * not workspace data.
 *
 * Access is gated to org admins/owners here (not per-action in the page),
 * matching the getWorkspace() -> notFound() convention used by the
 * workspace layout for unauthorized/non-member access.
 */
export default async function OrgSettingsLayout({
  children,
  params,
}: OrgSettingsLayoutProps) {
  const { orgSlug } = await params;

  const user = await getSessionUser();
  if (!user) {
    redirect("/login");
  }

  const prisma = getPrisma();

  // Independent of each other once the user id is known.
  const [orgMembership, workspaces] = await Promise.all([
    prisma.organizationMember.findFirst({
      where: { organization: { slug: orgSlug }, userId: user.id },
      select: { role: true },
    }),
    getUserWorkspaces(user.id),
  ]);

  // Normalized rather than matched exactly, for the same reason documented in
  // lib/permissions.ts and lib/roles.ts: the column is a bare VarChar with no
  // database enum, and several writers have put lowercase values into it. The
  // previous strict comparison here disagreed with the normalized check that
  // gates the actions inside this page, so an org owner stored as 'owner'
  // could be shown admin nav and then 404 on following it.
  if (!isOrgAdminRole(orgMembership?.role)) {
    notFound();
  }

  const anchorWorkspace = workspaces.find((ws) => ws.orgSlug === orgSlug);
  if (!anchorWorkspace) {
    // Org admin with no workspace membership in this org — no workspace to
    // anchor nav on. Extremely unlikely (org admins are typically also
    // workspace members) but fail safe rather than crash the chrome.
    notFound();
  }
  const cookieStore = await cookies();
  const sidebarDefaultOpen = cookieStore.get("sidebar_state")?.value !== "false";
  // Same server-seeded read as the workspace layout — see the note there.
  const initialPanelPin = parsePanelPin(
    cookieStore.get(panelPinCookieName("detail"))?.value
  );

  return (
    // MobileHeader calls usePanelContext() unconditionally, so it needs a
    // PanelProvider ancestor here just like the workspace layout provides —
    // without it, the org settings route crashes client-side on every visit
    // ("usePanelContext must be used inside PanelProvider"). PanelShell is
    // included for parity with the workspace layout; the discovery-rail
    // panel MobileHeader can open is never reachable from this org-scoped
    // route, so it stays closed here.
    <PanelProvider orgSlug={orgSlug} workspaceSlug={anchorWorkspace.slug}>
      <MobileHeader
        orgSlug={orgSlug}
        workspaceSlug={anchorWorkspace.slug}
        workspaceName={anchorWorkspace.name}
        userName={user.name ?? user.email ?? ""}
        userEmail={user.email ?? ""}
        userImage={user.image ?? undefined}
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
            isOrgAdmin
          />

          <SidebarInset className="min-w-0 overflow-y-auto bg-surface-app pb-16 md:pb-0">
            {children}
          </SidebarInset>

          {/* Inside SidebarProvider, after SidebarInset — see the note in the
              workspace layout. */}
          <PanelShell initialPin={initialPanelPin} />
        </SidebarProvider>
      </TooltipProvider>

      <BottomNav orgSlug={orgSlug} workspaceSlug={anchorWorkspace.slug} />
    </PanelProvider>
  );
}
