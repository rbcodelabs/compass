import Link from "next/link";
import { EntityCard } from "@/components/patterns/entity-card";
import { NO_CYCLE_LABEL, PERSISTENT_CYCLE_SLUG } from "@/lib/okr-cycle-scope";

interface PersistentObjectivesCardProps {
  objectiveCount: number;
  orgSlug: string;
  workspaceSlug: string;
}

/** Entry point for Objectives with no cycle, so they never vanish from the OKRs index. */
export function PersistentObjectivesCard({ objectiveCount, orgSlug, workspaceSlug }: PersistentObjectivesCardProps) {
  return (
    <Link
      href={`/${orgSlug}/${workspaceSlug}/okrs/${PERSISTENT_CYCLE_SLUG}`}
      className="block group"
      data-testid="persistent-objectives-card"
    >
      <EntityCard
        interactive
        className="h-full group-hover:-translate-y-0.5"
        title={NO_CYCLE_LABEL}
        description="Objectives not tied to a planning period"
      >
        <p className="text-sm text-text-subtle">
          {objectiveCount === 0 ? "No objectives yet" : `${objectiveCount} objective${objectiveCount === 1 ? "" : "s"}`}
        </p>
      </EntityCard>
    </Link>
  );
}
