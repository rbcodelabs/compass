"use client";

import type { CycleRollup, CycleTiming } from "@/lib/okr-cycle-rollup";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import { PaceNote, PaceTrack, ProgressRing, StatusMixBar } from "./okr-visuals";

interface CycleSummaryProps {
  rollup: CycleRollup;
  /** null for the cycle-less ("persistent") page, which has no calendar to pace against. */
  timing: CycleTiming | null;
}

function count(n: number, singular: string, pluralForm: string): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/** Rollup banner at the top of a cycle: average progress, status mix and (when it has dates) pace against the calendar. */
export function CycleSummary({ rollup, timing }: CycleSummaryProps) {
  const labels = useLabels();
  if (rollup.objectiveCount === 0) return null;
  const running = timing?.phase === "running";

  return (
    <section className="okx-summary" data-testid="cycle-summary" aria-label="Summary">
      <ProgressRing progress={rollup.progress} caption={`avg ${labels.keyResult.short}`} size="md" />
      <StatusMixBar
        mix={rollup.statusMix}
        title={`${count(rollup.objectiveCount, labels.objective.lower, labels.objective.lowerPlural)} · ${count(rollup.keyResultCount, labels.keyResult.lower, labels.keyResult.lowerPlural)}`}
      />
      <div className="okx-pace">
        <div className="okx-pace-top">
          <span className="okx-eyebrow">{timing ? "Progress vs time" : "Progress"}</span>
          {running && timing && <PaceNote progress={rollup.progress} elapsed={timing.percentElapsed} />}
        </div>
        <PaceTrack progress={rollup.progress} elapsed={running && timing ? timing.percentElapsed : null} legend />
      </div>
    </section>
  );
}
