import type { ReactNode } from "react";
import getPrisma from "@/lib/db";
import { getPortalSession } from "@/lib/portal-auth";
import { PortalAuthStatus } from "@/components/portal/portal-auth-status";
import { WorkspaceThemeStyle } from "@/components/branding/workspace-theme-style";
import { resolveWorkspaceBranding } from "@/lib/branding";

type Props = {
  children: ReactNode;
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
};

export default async function PortalLayout({ children, params }: Props) {
  const { orgSlug, workspaceSlug } = await params;
  const prisma = getPrisma();

  const [workspace, portalSession] = await Promise.all([
    prisma.workspace.findFirst({
      where: { slug: workspaceSlug, organization: { slug: orgSlug } },
      select: {
        name: true,
        brandingPaletteId: true,
        brandingPrimaryHex: true,
        brandingFontPresetId: true,
        brandingFontFamily: true,
        brandingLogoUrl: true,
      },
    }),
    getPortalSession(),
  ]);

  const workspaceName = workspace?.name ?? workspaceSlug;
  const branding = workspace ? resolveWorkspaceBranding(workspace) : null;

  return (
    <div className="flex min-h-screen flex-col bg-surface-app">
      <WorkspaceThemeStyle branding={branding} />
      <header className="border-b border-border-default bg-surface-panel px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center shrink-0 shadow-sm">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="white"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-4 h-4"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
              </svg>
            </div>
            <span className="text-sm font-semibold text-text-primary">{workspaceName}</span>
          </div>
          {portalSession && <PortalAuthStatus email={portalSession.email} />}
        </div>
      </header>

      <main className="flex-1 max-w-5xl mx-auto w-full px-6 py-8">
        {children}
      </main>

      <footer className="border-t border-border-default bg-surface-panel px-6 py-4 text-center">
        <p className="text-xs text-text-subtle">Powered by Compass</p>
      </footer>
    </div>
  );
}
