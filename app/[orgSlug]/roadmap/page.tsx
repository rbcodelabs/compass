import { notFound, redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { canShareOnSurface } from "@/lib/roadmap-views/access";
import { resolveRoadmapViewActor, listRoadmapViews } from "@/lib/roadmap-views/service";
import { loadCrossWorkspaceRoadmap, loadRoadmapFacets, MAX_ROADMAP_ITEMS } from "@/lib/roadmap-views/query";
import { groupRoadmapItems } from "@/lib/roadmap-views/group";
import {
  ROADMAP_URL_PARAMS,
  resolveRoadmapState,
  roadmapStateKey,
  type RawSearchParams,
} from "@/lib/roadmap-views/schema";
import { RoadmapToolbar } from "@/components/roadmap/cross-workspace/roadmap-toolbar";
import { RoadmapBoardResults, RoadmapTimelineResults } from "@/components/roadmap/cross-workspace/roadmap-results";

export const metadata = { title: "Roadmap · All workspaces" };

interface OrgRoadmapPageProps {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<RawSearchParams>;
}

/**
 * Cross-workspace roadmap: every roadmap item the viewer can read across one
 * organization, with URL-driven filters that can be saved as named views.
 *
 * Read-only by design. Cards link to the item in its own workspace, where it is
 * edited. The server is the only place scoping happens: items are always queried
 * against the workspaces the viewer can read, whatever a saved view or the URL names.
 */
export default async function OrgRoadmapPage({ params, searchParams }: OrgRoadmapPageProps) {
  const { orgSlug } = await params;
  const query = await searchParams;

  const user = await getSessionUser();
  if (!user) redirect("/login");

  const actor = await resolveRoadmapViewActor(user.id, orgSlug);
  if (!actor) notFound();

  const views = await listRoadmapViews(actor, null);
  const savedParam = query[ROADMAP_URL_PARAMS.savedView];
  const savedId = Array.isArray(savedParam) ? savedParam[0] : savedParam;
  // An id that no longer exists (deleted, or not visible to this viewer) just means "no saved view".
  const savedView = views.find((v) => v.id === savedId) ?? null;

  const state = resolveRoadmapState(query, savedView);
  const readableIds = actor.workspaces.map((w) => w.id);

  const [facets, { items, truncated }] = await Promise.all([
    loadRoadmapFacets(readableIds),
    loadCrossWorkspaceRoadmap(readableIds, state.filters, state.display),
  ]);

  const groups = groupRoadmapItems(items, state.display.groupBy, state.filters, facets.workspaces);
  const modified = savedView !== null && roadmapStateKey(state) !== roadmapStateKey(savedView);

  return (
    <div className="flex min-h-full flex-col">
      <RoadmapToolbar
        orgSlug={orgSlug}
        surfaceWorkspaceId={null}
        basePath={`/${orgSlug}/roadmap`}
        title="Roadmap"
        subtitle={`${items.length} ${items.length === 1 ? "item" : "items"} across ${facets.workspaces.length} ${facets.workspaces.length === 1 ? "workspace" : "workspaces"}`}
        state={state}
        views={views}
        savedViewId={savedView?.id ?? null}
        modified={modified}
        facets={facets}
        canShare={canShareOnSurface(actor, null)}
      />

      {truncated && (
        <p role="status" className="mx-4 mt-4 rounded-lg border border-status-warning/30 bg-status-warning-surface px-3 py-2 text-sm text-status-warning md:mx-6">
          Showing the first {MAX_ROADMAP_ITEMS.toLocaleString()} items. Narrow the filters to see the rest.
        </p>
      )}

      {items.length === 0 ? (
        <div className="p-6">
          <p data-testid="cross-roadmap-empty" className="rounded-lg border border-dashed border-border-default p-6 text-sm text-text-secondary">
            No roadmap items match these filters.
          </p>
        </div>
      ) : state.display.view === "timeline" ? (
        <RoadmapTimelineResults orgSlug={orgSlug} groups={groups} groupBy={state.display.groupBy} />
      ) : (
        <RoadmapBoardResults orgSlug={orgSlug} groups={groups} groupBy={state.display.groupBy} />
      )}
    </div>
  );
}
