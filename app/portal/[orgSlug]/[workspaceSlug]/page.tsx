import getPrisma from "@/lib/db";
import { getPortalSession } from "@/lib/portal-auth";
import { isPermissionError, resolveWorkspaceAdmin } from "@/lib/permissions";
import { EmptyState } from "@/components/patterns/empty-state";
import { EmptyHome, PortalHomeBoard } from "@/components/portal-home/board";
import { PortalHomeEditor } from "@/components/portal-home/editor";
import { buildDefaultWidgets } from "@/lib/portal-home/defaults";
import { resolveHomeForCustomer, resolveHomeForMember } from "@/lib/portal-home/resolve";
import { loadHomeLayout, loadPublishedWidgets } from "@/lib/portal-home/service";

type Props = {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
};

/** Compass admins (Auth.js session) get the editor; a portal session never does. */
async function isHomeAdmin(orgSlug: string, workspaceSlug: string): Promise<boolean> {
  try {
    await resolveWorkspaceAdmin(orgSlug, workspaceSlug);
    return true;
  } catch (error) {
    if (isPermissionError(error)) return false;
    throw error;
  }
}

export default async function PortalHomePage({ params }: Props) {
  const { orgSlug, workspaceSlug } = await params;
  const prisma = getPrisma();

  const [workspace, portalSession] = await Promise.all([
    prisma.workspace.findFirst({
      where: { slug: workspaceSlug, organization: { slug: orgSlug } },
      select: { id: true, name: true, roadmapPublic: true, feedbackEnabled: true },
    }),
    getPortalSession(),
  ]);

  if (!workspace) {
    return <EmptyState title="Portal not found" description="This portal does not exist." />;
  }

  const resolveContext = {
    prisma,
    workspace: {
      id: workspace.id,
      orgSlug,
      workspaceSlug,
      roadmapPublic: workspace.roadmapPublic === true,
      feedbackEnabled: workspace.feedbackEnabled === true,
    },
  };
  const defaults = buildDefaultWidgets({
    workspaceName: workspace.name,
    orgSlug,
    workspaceSlug,
    roadmapPublic: workspace.roadmapPublic === true,
    feedbackEnabled: workspace.feedbackEnabled === true,
  });

  // Customers only ever read the PUBLISHED layout (or the default). Visibility
  // and public-data rules are applied server-side inside resolveHomeForCustomer.
  const published = await loadPublishedWidgets(prisma, workspace.id);
  const baseline = published ?? defaults;
  const home = await resolveHomeForCustomer(resolveContext, baseline, { signedIn: !!portalSession });
  const board =
    home.widgets.length > 0 ? (
      <PortalHomeBoard widgets={home.widgets} resolved={home.resolved} />
    ) : (
      <EmptyHome>Nothing to show here yet. Check back soon.</EmptyHome>
    );

  if (!(await isHomeAdmin(orgSlug, workspaceSlug))) return board;

  const layout = await loadHomeLayout(prisma, workspace.id);
  const draft = layout.hasRow ? layout.draft : defaults;
  const initialResolved = await resolveHomeForMember(resolveContext, draft);

  return (
    <PortalHomeEditor
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      initialDraft={draft}
      initialBaseline={baseline}
      publishedAt={layout.publishedAt?.toISOString() ?? null}
      initialResolved={initialResolved}
    >
      {board}
    </PortalHomeEditor>
  );
}
