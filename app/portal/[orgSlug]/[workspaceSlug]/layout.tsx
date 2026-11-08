import type { ReactNode } from "react";
import getPrisma from "@/lib/db";
import { getPortalSession } from "@/lib/portal-auth";
import { WorkspaceThemeStyle } from "@/components/branding/workspace-theme-style";
import { resolveWorkspaceBranding } from "@/lib/branding";
import { buildDefaultWidgets } from "@/lib/portal-home/defaults";
import { loadPublishedHome } from "@/lib/portal-home/service";
import { loadPortalHeroMeta } from "@/lib/portal-home/hero-meta";
import { listPublishedDocs } from "@/lib/portal-docs/service";
import { popularSearchTerms } from "@/lib/portal-docs/format";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { workspaceThemeInitScript } from "@/lib/theme";
import { PortalShell } from "@/components/portal-home/templates/portal-shell";

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
        id: true,
        name: true,
        roadmapPublic: true,
        feedbackEnabled: true,
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
  const roadmapPublic = workspace?.roadmapPublic === true;
  const feedbackEnabled = workspace?.feedbackEnabled === true;

  // The PUBLISHED template (customers never see a draft's). An unpublished workspace gets the default
  // editorial home, so its widget list is the default one.
  const published = workspace ? await loadPublishedHome(prisma, workspace.id) : { widgets: null, template: "editorial" as const };
  const widgets =
    published.widgets ??
    buildDefaultWidgets({ workspaceName, orgSlug, workspaceSlug, roadmapPublic, feedbackEnabled });

  const showDocs = widgets.some((widget) => widget.type === "docs");
  // Template extras, derived from data customers may already see. Each is only loaded for the template that
  // renders it, so the other templates pay no extra queries.
  const heroMeta =
    workspace && published.template === "editorial"
      ? await loadPortalHeroMeta(prisma, { workspaceId: workspace.id, roadmapPublic, showDocs })
      : undefined;
  const searchSuggestions =
    workspace && published.template === "docs_hub" && showDocs
      ? popularSearchTerms((await listPublishedDocs(prisma, workspace.id, { limit: 6 })).map((doc) => doc.title))
      : undefined;

  // ThemeProvider is the app's one dark-mode mechanism (the `dark` class on <html>): the visitor's stored
  // preference, else their system setting. Every template uses semantic tokens, so each follows it.
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: workspaceThemeInitScript }} />
      <WorkspaceThemeStyle branding={branding} />
      <ThemeProvider>
        <div className="workspace-theme-scope contents">
        <PortalShell
          template={published.template}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          workspaceName={workspaceName}
          logoUrl={branding?.logoUrl ?? null}
          roadmapPublic={roadmapPublic}
          feedbackEnabled={feedbackEnabled}
          email={portalSession?.email ?? null}
          showDocs={showDocs}
          heroMeta={heroMeta}
          searchSuggestions={searchSuggestions}
        >
          {children}
        </PortalShell>
        </div>
      </ThemeProvider>
    </>
  );
}
