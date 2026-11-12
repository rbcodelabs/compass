"use client";

import { DeliveryStatusBadge } from "./delivery-status-badge";
import { usePanelContext } from "@/components/panels/panel-context";
import { setPanelSeed } from "@/lib/panel-seed";
import { captureGalleryPreview } from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions";
import { groupGalleryItems, type GalleryGroupMode, type GalleryItemExtras } from "@/lib/roadmap/gallery";
import { ArtifactHero } from "@/components/gallery/artifact-hero";
import { GalleryGroupSections } from "@/components/gallery/gallery-group-sections";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import type { RoadmapCardData } from "./roadmap-card";
import type { SquadData } from "@/lib/types";

const HORIZON_LABEL: Record<string, string> = { NOW: "Now", NEXT: "Next", LATER: "Later", LAUNCHING: "Launching", LAUNCHED: "Launched", SHIPPED: "Shipped" };

function Hero({ item, extras, workspaceId, orgSlug, workspaceSlug }: { item: RoadmapCardData; extras: GalleryItemExtras; workspaceId: string; orgSlug: string; workspaceSlug: string }) {
  const labels = useLabels();
  const solution = labels.solution.singular.toLowerCase();
  return (
    <ArtifactHero
      artifacts={extras.artifacts}
      moreArtifacts={extras.moreArtifacts}
      isPrivate={item.isPrivate}
      emptyTitle={item.solutionId ? `No artifact is linked to this ${solution} yet` : `No ${solution} is linked to this item yet`}
      emptyHint={`Open the item to ${item.solutionId ? "link an artifact" : `link a ${solution}`}.`}
      artifactHref={(artifactId) => `/${orgSlug}/${workspaceSlug}/docs/artifacts/${artifactId}`}
      onCapture={(artifactId) => captureGalleryPreview(workspaceId, artifactId)}
    />
  );
}

function GalleryCard({ item, extras, workspaceId, orgSlug, workspaceSlug }: { item: RoadmapCardData; extras: GalleryItemExtras; workspaceId: string; orgSlug: string; workspaceSlug: string }) {
  const { openPanel } = usePanelContext();
  const open = () => {
    setPanelSeed("roadmapItem", item.id, item);
    openPanel("roadmapItem", item.id);
  };
  const crumb = [item.opportunity?.title, item.solution?.title].filter(Boolean).join(" › ");

  return (
    <article data-testid="gallery-card" data-item-id={item.id} className="group relative flex flex-col rounded-xl border border-border-default bg-surface-card shadow-sm transition-shadow hover:shadow-lg focus-within:shadow-lg">
      <Hero item={item} extras={extras} workspaceId={workspaceId} orgSlug={orgSlug} workspaceSlug={workspaceSlug} />
      <div className="flex flex-col gap-2 p-4">
        <h3 className="text-base font-semibold leading-snug tracking-tight text-text-primary">
          <button type="button" onClick={open} className="text-left after:absolute after:inset-0 after:z-10 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring">
            {item.title}
          </button>
        </h3>
        {crumb && <p className="truncate text-xs text-text-subtle">{crumb}</p>}
        <div className="flex flex-wrap items-center gap-1.5">
          {item.squad && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border-default px-2 py-0.5 text-xs">
              <span aria-hidden="true" className="size-2 rounded-full" style={{ backgroundColor: item.squad.color }} />
              {item.squad.name}
            </span>
          )}
          <span className="rounded-full bg-surface-inset px-2 py-0.5 text-xs font-medium">{HORIZON_LABEL[item.horizon] ?? item.horizon}</span>
          <span className="ml-auto"><DeliveryStatusBadge status={item.deliveryStatus} /></span>
        </div>
      </div>
    </article>
  );
}

/**
 * The roadmap's Gallery view: one large card per roadmap item whose hero is the
 * screenshot of an Artifact linked to the item's Solution. Read-only display; opening a
 * card opens the usual roadmap item panel.
 */
export function RoadmapGallery({ items, extras, squads, groupMode, workspaceId, orgSlug, workspaceSlug }: {
  items: RoadmapCardData[];
  extras: Record<string, GalleryItemExtras>;
  squads: SquadData[];
  groupMode: GalleryGroupMode;
  workspaceId: string;
  orgSlug: string;
  workspaceSlug: string;
}) {
  const labels = useLabels();
  const groups = groupGalleryItems(items, groupMode, { squads, extras, noSolutionLabel: `No ${labels.solution.singular.toLowerCase()}` });
  const empty: GalleryItemExtras = { solutionStatus: null, artifacts: [], moreArtifacts: 0 };

  if (items.length === 0) {
    return <p className="p-8 text-sm text-text-subtle" data-testid="gallery-empty">No roadmap items match these filters.</p>;
  }

  return (
    <GalleryGroupSections
      groups={groups}
      groupMode={groupMode}
      testId="roadmap-gallery"
      renderItem={(item) => (
        <GalleryCard key={item.id} item={item} extras={extras[item.id] ?? empty} workspaceId={workspaceId} orgSlug={orgSlug} workspaceSlug={workspaceSlug} />
      )}
    />
  );
}
