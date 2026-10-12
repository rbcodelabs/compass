"use client";

import Link from "next/link";
import { Infinity as InfinityIcon, Target } from "lucide-react";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import { WorkspaceCover } from "@/components/workspace-selector/workspace-cover";
import { PERSISTENT_CYCLE_SLUG, noCycleLabel } from "@/lib/okr-cycle-scope";
import "./okrs-gallery.css";

interface PersistentObjectivesCardProps {
  objectiveCount: number;
  orgSlug: string;
  workspaceSlug: string;
}

/** Entry point for Objectives with no cycle, so they never vanish from the OKRs index. */
export function PersistentObjectivesCard({ objectiveCount, orgSlug, workspaceSlug }: PersistentObjectivesCardProps) {
  const labels = useLabels();
  const title = noCycleLabel(labels.cycle);
  return (
    <Link
      href={`/${orgSlug}/${workspaceSlug}/okrs/${PERSISTENT_CYCLE_SLUG}`}
      className="wsx-tile okx-tile okx-tile-dashed"
      data-testid="persistent-objectives-card"
    >
      <WorkspaceCover name={title} neutral>
        <span className="okx-cover-text">
          <span className="okx-kicker">Persistent</span>
          <span className="okx-cover-name">{title}</span>
        </span>
      </WorkspaceCover>

      <div className="okx-tile-body">
        <p className="okx-tile-desc">{labels.objective.plural} not tied to a planning period</p>
      </div>

      <div className="wsx-tile-meta">
        <span>
          <Target className="wsx-icon" aria-hidden="true" />
          {objectiveCount === 0
            ? `No ${labels.objective.lowerPlural} yet`
            : `${objectiveCount} ${objectiveCount === 1 ? labels.objective.lower : labels.objective.lowerPlural}`}
        </span>
        <span>
          <InfinityIcon className="wsx-icon" aria-hidden="true" />
          Always on
        </span>
      </div>
    </Link>
  );
}
