import { auth } from "@/auth";
import { redirect, notFound } from "next/navigation";
import { getUserWorkspaces } from "@/lib/workspace";
import getPrisma from "@/lib/db";
import { Sidebar } from "@/components/sidebar";
import { BottomNav } from "@/components/bottom-nav";
import { MobileHeader } from "@/components/mobile-header";

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

  return (
    <>
      <MobileHeader
        orgSlug={orgSlug}
        workspaceSlug={anchorWorkspace.slug}
        workspaceName={anchorWorkspace.name}
        userName={session.user.name ?? session.user.email ?? ""}
        userEmail={session.user.email ?? ""}
        userImage={session.user.image ?? undefined}
      />

      <div className="flex h-[calc(100dvh-3.5rem)] md:h-screen overflow-hidden">
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

        <main className="flex-1 overflow-y-auto bg-slate-50 pb-16 md:pb-0">{children}</main>
      </div>

      <BottomNav orgSlug={orgSlug} workspaceSlug={anchorWorkspace.slug} />
    </>
  );
}
