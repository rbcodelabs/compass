"use client";

import Link from "next/link";
import { EntityCard } from "@/components/patterns/entity-card";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import { PERSISTENT_CYCLE_SLUG, noCycleLabel } from "@/lib/okr-cycle-scope";

interface PersistentObjectivesCardProps {
  objectiveCount: number;
  orgSlug: string;
  workspaceSlug: string;
}

/** Entry point for Objectives with no cycle, so they never vanish from the OKRs index. */
export function PersistentObjectivesCard({ objectiveCount, orgSlug, workspaceSlug }: PersistentObjectivesCardProps) {
  const labels = useLabels();
  return (
    <Link
      href={`/${orgSlug}/${workspaceSlug}/okrs/${PERSISTENT_CYCLE_SLUG}`}
      className="block group"
      data-testid="persistent-objectives-card"
    >
      <EntityCard
        interactive
        className="h-full group-hover:-translate-y-0.5"
        title={noCycleLabel(labels.cycle)}
        description={`${labels.objective.plural} not tied to a planning period`}
      >
        <p className="text-sm text-text-subtle">
          {objectiveCount === 0 ? `No ${labels.objective.lowerPlural} yet` : `${objectiveCount} ${objectiveCount === 1 ? labels.objective.lower : labels.objective.lowerPlural}`}
        </p>
      </EntityCard>
    </Link>
  );
}
