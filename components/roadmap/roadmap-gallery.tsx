"use client";

import { useState, useTransition } from "react";
import { ChevronDown, FileText, ImageOff, Link2, Lock, Plus, Presentation, Sparkles } from "lucide-react";
import { DeliveryStatusBadge } from "./delivery-status-badge";
import { usePanelContext } from "@/components/panels/panel-context";
import { setPanelSeed } from "@/lib/panel-seed";
import { captureGalleryPreview } from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions";
import { groupGalleryItems, type GalleryArtifact, type GalleryGroupMode, type GalleryItemExtras } from "@/lib/roadmap/gallery";
import { cn } from "@/lib/utils";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import type { RoadmapCardData } from "./roadmap-card";
import type { SquadData } from "@/lib/types";

const HORIZON_LABEL: Record<string, string> = { NOW: "Now", NEXT: "Next", LATER: "Later", LAUNCHING: "Launching", LAUNCHED: "Launched", SHIPPED: "Shipped" };

function artifactTypeLabel(artifact: GalleryArtifact): { label: string; icon: React.ReactNode } {
  if (artifact.kind === "SLIDE_DECK") return { label: "Slide deck", icon: <Presentation aria-hidden="true" className="size-3" /> };
  if (artifact.sourceType === "EXTERNAL_LINK") return { label: "Link", icon: <Link2 aria-hidden="true" className="size-3" /> };
  if (artifact.sourceType === "V0_CHAT") return { label: "v0 chat", icon: <Sparkles aria-hidden="true" className="size-3" /> };
  return { label: "HTML", icon: <FileText aria-hidden="true" className="size-3" /> };
}

function Hero({ item, extras, workspaceId, orgSlug, workspaceSlug }: { item: RoadmapCardData; extras: GalleryItemExtras; workspaceId: string; orgSlug: string; workspaceSlug: string }) {
  const { artifacts, moreArtifacts } = extras;
  // Open on the first artifact that has a screenshot (newest-first order); only fall back to a placeholder when none do.
  const [active, setActive] = useState(() => Math.max(0, artifacts.findIndex((artifact) => artifact.thumbnail)));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const labels = useLabels();
  const solution = labels.solution.singular.toLowerCase();
  const current = artifacts[Math.min(active, Math.max(artifacts.length - 1, 0))];
  const withShot = artifacts.filter((artifact) => artifact.thumbnail);

  const frame = "relative aspect-[16/10] overflow-hidden rounded-t-xl border-b border-border-default bg-surface-inset";

  if (!current) {
    return (
      <div className={frame} data-testid="gallery-hero-empty">
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-text-subtle [background:repeating-linear-gradient(135deg,transparent_0_10px,var(--color-surface-panel)_10px_20px)]">
          <Plus aria-hidden="true" className="size-5" />
          <p className="max-w-[26ch] text-xs">{item.solutionId ? `No artifact is linked to this ${solution} yet` : `No ${solution} is linked to this item yet`}</p>
          <p className="text-xs">Open the item to {item.solutionId ? "link an artifact" : `link a ${solution}`}.</p>
        </div>
      </div>
    );
  }

  const type = artifactTypeLabel(current);
  return (
    <div className={frame}>
      {current.thumbnail ? (
        // A plain <img>, not next/image: the source is an authenticated, no-store route the image optimizer would fetch without the reader's session.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={current.thumbnail.src} width={current.thumbnail.width} height={current.thumbnail.height} alt={`Preview of ${current.title}`} loading="lazy" className="absolute inset-0 size-full object-cover object-top" />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-panel p-4 text-center text-text-subtle" data-testid="gallery-hero-pending">
          <ImageOff aria-hidden="true" className="size-5" />
          <p className="max-w-[28ch] text-xs">
            {artifacts.length} artifact{artifacts.length === 1 ? "" : "s"} linked, no preview captured yet
          </p>
          {current.capturable ? (
            <button
              type="button"
              disabled={pending}
              onClick={(event) => {
                event.stopPropagation();
                setError(null);
                startTransition(async () => {
                  const result = await captureGalleryPreview(workspaceId, current.id);
                  if (!result.ok) setError(result.error);
                });
              }}
              className="relative z-20 rounded-md border border-border-default bg-surface-card px-3 py-1.5 text-xs font-medium text-text-primary hover:border-primary hover:text-primary disabled:opacity-60"
            >
              {pending ? "Capturing…" : "Capture preview"}
            </button>
          ) : (
            <a href={`/${orgSlug}/${workspaceSlug}/docs/artifacts/${current.id}`} className="relative z-20 text-xs font-medium underline">Open artifact</a>
          )}
          {error && <p role="alert" className="max-w-[32ch] text-xs text-status-danger">{error}</p>}
        </div>
      )}

      <span className="absolute left-2.5 top-2.5 z-10 inline-flex items-center gap-1 rounded-md bg-surface-card/90 px-2 py-0.5 text-[11px] font-semibold text-text-primary shadow-sm">
        {type.icon}
        {type.label}
      </span>
      {item.isPrivate && (
        <span className="absolute right-2.5 top-2.5 z-10 inline-flex items-center gap-1 rounded-md bg-black/75 px-2 py-0.5 text-[11px] font-medium text-white">
          <Lock aria-hidden="true" className="size-3" /> Private
        </span>
      )}

      {artifacts.length > 1 && (
        <div role="group" aria-label="Artifacts" className="absolute bottom-2.5 left-2.5 z-20 flex items-center gap-1.5">
          {artifacts.slice(0, 3).map((artifact, index) => (
            <button
              key={artifact.id}
              type="button"
              aria-label={`Show ${artifact.title}`}
              aria-pressed={index === active}
              onClick={(event) => { event.stopPropagation(); setActive(index); }}
              onMouseEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
              className={cn(
                "relative h-8 w-12 overflow-hidden rounded-md border-2 bg-surface-panel shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-black/70",
                index === active ? "border-primary" : "border-white/80 opacity-85",
              )}
            >
              {artifact.thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={artifact.thumbnail.src} alt="" loading="lazy" className="size-full object-cover object-top" />
              ) : (
                <ImageOff aria-hidden="true" className="mx-auto size-3 text-text-subtle" />
              )}
            </button>
          ))}
          {artifacts.length + moreArtifacts > 3 && (
            <span className="rounded-md bg-black/75 px-1.5 py-0.5 text-[11px] font-medium text-white">+{artifacts.length + moreArtifacts - 3}</span>
          )}
        </div>
      )}
      {withShot.length === 0 && artifacts.length > 1 && <span className="sr-only">None of the linked artifacts has a captured preview yet.</span>}
    </div>
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
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const labels = useLabels();
  const groups = groupGalleryItems(items, groupMode, { squads, extras, noSolutionLabel: `No ${labels.solution.singular.toLowerCase()}` });
  const empty: GalleryItemExtras = { solutionStatus: null, artifacts: [], moreArtifacts: 0 };

  if (items.length === 0) {
    return <p className="p-8 text-sm text-text-subtle" data-testid="gallery-empty">No roadmap items match these filters.</p>;
  }

  return (
    <div className="flex flex-col gap-8 p-4 md:p-7" data-testid="roadmap-gallery">
      {groups.map((group) => {
        const closed = collapsed[`${groupMode}:${group.key}`] ?? false;
        const gridId = `gallery-group-${groupMode}-${group.key}`;
        return (
          <section key={group.key} aria-label={group.label}>
            {groupMode !== "none" && (
              <button
                type="button"
                aria-expanded={!closed}
                aria-controls={gridId}
                onClick={() => setCollapsed((prev) => ({ ...prev, [`${groupMode}:${group.key}`]: !closed }))}
                className="mb-3 flex items-center gap-2 text-sm font-semibold"
              >
                <ChevronDown aria-hidden="true" className={cn("size-4 text-text-subtle transition-transform", closed && "-rotate-90")} />
                {group.color && <span aria-hidden="true" className="size-2.5 rounded-full" style={{ backgroundColor: group.color }} />}
                <h2>{group.label}</h2>
                <span className="rounded-full bg-surface-inset px-2 py-0.5 text-xs font-normal text-text-subtle">{group.items.length}</span>
              </button>
            )}
            {/* The padding gives the cards' shadows room, so the scroll container never clips them. */}
            <div id={gridId} hidden={closed} className="grid grid-cols-1 gap-7 px-0.5 pb-2 md:grid-cols-2 xl:grid-cols-3">
              {group.items.map((item) => (
                <GalleryCard key={item.id} item={item} extras={extras[item.id] ?? empty} workspaceId={workspaceId} orgSlug={orgSlug} workspaceSlug={workspaceSlug} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
