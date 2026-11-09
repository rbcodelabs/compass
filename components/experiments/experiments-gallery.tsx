"use client";

import { StatusBadge } from "@/components/patterns/status-badge";
import { usePanelContext } from "@/components/panels/panel-context";
import { ArtifactHero } from "@/components/gallery/artifact-hero";
import { GalleryGroupSections } from "@/components/gallery/gallery-group-sections";
import { captureArtifactThumbnail } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions";
import { useLiveRefresh } from "@/hooks/use-live-refresh";
import {
  EXPERIMENT_CONCLUSION_LABEL,
  EXPERIMENT_STATUS_LABEL,
  EXPERIMENT_STATUS_TONE,
  groupExperimentGalleryItems,
  type ExperimentGalleryGroupMode,
  type ExperimentGalleryItem,
} from "@/lib/experiments/gallery";
import type { GalleryArtifactSet } from "@/lib/gallery/artifacts";
import type { Conclusion, SquadData } from "@/lib/types";

const CONCLUSION_TONE: Record<Conclusion, string> = {
  PROCEED: "border-status-success/30 text-status-success",
  KILL: "border-status-danger/30 text-status-danger",
  ITERATE: "border-status-warning/30 text-status-warning",
  NOT_PURSUED: "border-status-neutral/30 text-status-neutral",
};

const EMPTY_SET: GalleryArtifactSet = { artifacts: [], moreArtifacts: 0 };

function GalleryCard({ experiment, artifacts, workspaceId, orgSlug, workspaceSlug }: { experiment: ExperimentGalleryItem; artifacts: GalleryArtifactSet; workspaceId: string; orgSlug: string; workspaceSlug: string }) {
  const { openPanel } = usePanelContext();
  const conclusion = experiment.conclusion as Conclusion | null;
  const conclusionLabel = conclusion ? EXPERIMENT_CONCLUSION_LABEL[conclusion] ?? experiment.conclusion : null;

  return (
    <article data-testid="gallery-card" data-item-id={experiment.id} className="group relative flex flex-col rounded-xl border border-border-default bg-surface-card shadow-sm transition-shadow hover:shadow-lg focus-within:shadow-lg">
      <ArtifactHero
        artifacts={artifacts.artifacts}
        moreArtifacts={artifacts.moreArtifacts}
        isPrivate={false}
        emptyTitle="No artifact is linked to this experiment yet"
        emptyHint="Open the experiment to link an artifact from the experiment panel."
        artifactHref={(artifactId) => `/${orgSlug}/${workspaceSlug}/docs/artifacts/${artifactId}`}
        onCapture={(artifactId) => captureArtifactThumbnail(workspaceId, artifactId, `/${orgSlug}/${workspaceSlug}/experiments`)}
      />
      <div className="flex flex-col gap-2 p-4">
        <h3 className="text-base font-semibold leading-snug tracking-tight text-text-primary">
          <button type="button" onClick={() => openPanel("experiment", experiment.id)} className="text-left after:absolute after:inset-0 after:z-10 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring">
            {experiment.title}
          </button>
        </h3>
        {experiment.hypothesis && <p className="line-clamp-3 text-sm text-text-subtle">{experiment.hypothesis}</p>}
        <div className="flex flex-wrap items-center gap-1.5">
          {experiment.squad && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border-default px-2 py-0.5 text-xs">
              <span aria-hidden="true" className="size-2 rounded-full" style={{ backgroundColor: experiment.squad.color }} />
              {experiment.squad.name}
            </span>
          )}
          {conclusionLabel && (
            <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${(conclusion && CONCLUSION_TONE[conclusion]) ?? ""}`}>{conclusionLabel}</span>
          )}
          <span className="ml-auto"><StatusBadge status={EXPERIMENT_STATUS_TONE[experiment.status]}>{EXPERIMENT_STATUS_LABEL[experiment.status]}</StatusBadge></span>
        </div>
      </div>
    </article>
  );
}

/**
 * The Experiments Gallery view: one large card per experiment whose hero is the screenshot of an Artifact
 * linked to the experiment. Read-only display; opening a card opens the usual experiment panel.
 *
 * It owns the live refresh the Board would otherwise provide: the Board is not mounted in this view, so
 * without this the gallery would go stale while someone else edits.
 */
export function ExperimentsGallery({ experiments, extras, squads, groupMode, workspaceId, orgSlug, workspaceSlug }: {
  experiments: ExperimentGalleryItem[];
  extras: Record<string, GalleryArtifactSet>;
  squads: SquadData[];
  groupMode: ExperimentGalleryGroupMode;
  workspaceId: string;
  orgSlug: string;
  workspaceSlug: string;
}) {
  useLiveRefresh({ orgSlug, workspaceSlug, scope: "experiments" });
  const groups = groupExperimentGalleryItems(experiments, groupMode, { squads });

  if (experiments.length === 0) {
    return <p className="p-8 text-sm text-text-subtle" data-testid="gallery-empty">No experiments match these filters.</p>;
  }

  return (
    <GalleryGroupSections
      groups={groups}
      groupMode={groupMode}
      testId="experiments-gallery"
      renderItem={(experiment) => (
        <GalleryCard key={experiment.id} experiment={experiment} artifacts={extras[experiment.id] ?? EMPTY_SET} workspaceId={workspaceId} orgSlug={orgSlug} workspaceSlug={workspaceSlug} />
      )}
    />
  );
}
