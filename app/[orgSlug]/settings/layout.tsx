import { auth } from "@/auth";
import { redirect, notFound } from "next/navigation";
import { getUserWorkspaces } from "@/lib/workspace";
import getPrisma from "@/lib/db";
import { Sidebar } from "@/components/sidebar";
import { BottomNav } from "@/components/bottom-nav";
import { MobileHeader } from "@/components/mobile-header";
import { PanelProvider } from "@/components/panels/panel-context";
import { PanelShell } from "@/components/panels/panel-shell";
import { cookies } from "next/headers";
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
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }

  const { orgSlug } = await params;
  const prisma = getPrisma();

  const orgMembership = await prisma.organizationMember.findFirst({
    where: { organization: { slug: orgSlug }, userId: session.user.id },
    select: { role: true },
  });

  if (!orgMembership || (orgMembership.role !== "OWNER" && orgMembership.role !== "ADMIN")) {
    notFound();
  }

  const workspaces = await getUserWorkspaces(session.user.id);
  const anchorWorkspace = workspaces.find((ws) => ws.orgSlug === orgSlug);
  if (!anchorWorkspace) {
    // Org admin with no workspace membership in this org — no workspace to
    // anchor nav on. Extremely unlikely (org admins are typically also
    // workspace members) but fail safe rather than crash the chrome.
    notFound();
  }
  const cookieStore = await cookies();
  const sidebarDefaultOpen = cookieStore.get("sidebar_state")?.value !== "false";

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
            orgSlug={orgSlug}
            workspaceSlug={anchorWorkspace.slug}
            workspaceName={anchorWorkspace.name}
            userName={session.user.name ?? session.user.email ?? ""}
            userEmail={session.user.email ?? ""}
            userImage={session.user.image ?? undefined}
            workspaces={workspaces}
            isOrgAdmin
          />

          <SidebarInset className="min-w-0 overflow-y-auto bg-surface-app pb-16 md:pb-0">
            {children}
          </SidebarInset>
        </SidebarProvider>
      </TooltipProvider>

      <BottomNav orgSlug={orgSlug} workspaceSlug={anchorWorkspace.slug} />

      <PanelShell />
    </PanelProvider>
  );
}
