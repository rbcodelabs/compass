"use client";

import Link from "next/link";
import { ArrowRight, CalendarDays, Target } from "lucide-react";
import type { CycleStatus } from "@/lib/types";
import type { CycleRollup, CycleTiming } from "@/lib/okr-cycle-rollup";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import { WorkspaceCover } from "@/components/workspace-selector/workspace-cover";
import { PaceNote, PaceTrack, ProgressRing, StatusChips, StatusMixBar, formatDateRange } from "./okr-visuals";

/** Everything a tile needs, already rolled up on the server so the client does no date math (no hydration drift). */
export interface CycleCardData {
  id: string;
  title: string;
  startDate: Date;
  endDate: Date;
  status: CycleStatus;
  rollup: CycleRollup;
  timing: CycleTiming;
}

interface CycleCardProps {
  cycle: CycleCardData;
  orgSlug: string;
  workspaceSlug: string;
}

function plural(n: number, singular: string, pluralForm: string): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

function shortDate(d: Date): string {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** Cover pill + kicker for a cycle, from its stored status and where today falls in its dates. */
function coverCopy(cycle: CycleCardData): { pill: string; kicker: string; current: boolean } {
  const { status, timing } = cycle;
  if (status === "CLOSED") return { pill: `Closed ${shortDate(cycle.endDate)}`, kicker: "Final", current: false };
  if (status === "DRAFT") {
    return timing.phase === "upcoming"
      ? { pill: `Starts in ${plural(timing.daysUntilStart, "day", "days")}`, kicker: "Upcoming", current: false }
      : { pill: "Draft", kicker: "Draft", current: false };
  }
  if (timing.phase === "upcoming") return { pill: "Current", kicker: `Starts in ${plural(timing.daysUntilStart, "day", "days")}`, current: true };
  if (timing.phase === "ended") return { pill: "Current", kicker: "Past end date", current: true };
  return { pill: "Current", kicker: `${plural(timing.daysLeft, "day", "days")} left`, current: true };
}

function CycleCoverText({ cycle, kicker }: { cycle: CycleCardData; kicker: string }) {
  return (
    <span className="okx-cover-text">
      <span className="okx-kicker">{kicker}</span>
      <span className="okx-cover-name">{cycle.title}</span>
    </span>
  );
}

/** Featured card for the active cycle: ring, status mix and pace against the calendar. */
export function CycleHero({ cycle, orgSlug, workspaceSlug }: CycleCardProps) {
  const labels = useLabels();
  const { rollup, timing } = cycle;
  const { pill, kicker } = coverCopy(cycle);
  const running = timing.phase === "running";
  const empty = rollup.objectiveCount === 0;
  // Not started yet: nothing to measure, so no ring or pace track.
  const notStarted = timing.phase === "upcoming";

  return (
    <Link href={`/${orgSlug}/${workspaceSlug}/okrs/${cycle.id}`} className="wsx-tile okx-tile okx-hero" data-testid="cycle-hero">
      <WorkspaceCover name={cycle.title}>
        <CycleCoverText cycle={cycle} kicker={kicker} />
        <span className="wsx-pill wsx-pill-here">{pill}</span>
      </WorkspaceCover>

      {empty ? (
        <div className="okx-hero-body" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
          <p className="okx-tile-desc">
            No {labels.objective.lowerPlural} in this {labels.cycle.lower} yet. Open it to add the first one.
          </p>
        </div>
      ) : notStarted ? (
        <div className="okx-hero-body" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
          <StatusMixBar mix={rollup.statusMix} title={`${plural(rollup.objectiveCount, labels.objective.lower, labels.objective.lowerPlural)} by status`} />
        </div>
      ) : (
        <div className="okx-hero-body">
          <ProgressRing progress={rollup.progress} caption={`avg ${labels.keyResult.short}`} />
          <StatusMixBar mix={rollup.statusMix} title={`${plural(rollup.objectiveCount, labels.objective.lower, labels.objective.lowerPlural)} by status`} />
          <div className="okx-hero-side">
            <div className="okx-pace">
              <div className="okx-pace-top">
                <span className="okx-eyebrow">Progress vs time</span>
                {running && <PaceNote progress={rollup.progress} elapsed={timing.percentElapsed} />}
              </div>
              <PaceTrack progress={rollup.progress} elapsed={running ? timing.percentElapsed : null} legend />
            </div>
          </div>
        </div>
      )}

      <div className="okx-hero-foot">
        <span>
          <Target aria-hidden="true" />
          {plural(rollup.objectiveCount, labels.objective.lower, labels.objective.lowerPlural)}
        </span>
        <span>{plural(rollup.keyResultCount, labels.keyResult.lower, labels.keyResult.lowerPlural)}</span>
        <span>
          <CalendarDays aria-hidden="true" />
          {formatDateRange(cycle.startDate, cycle.endDate)}
        </span>
        <span className="okx-open">
          Open {labels.cycle.lower} <ArrowRight aria-hidden="true" style={{ width: 14, height: 14 }} />
        </span>
      </div>
    </Link>
  );
}

/** Gallery tile for any other cycle (extra active, upcoming/draft, closed). */
export function CycleCard({ cycle, orgSlug, workspaceSlug }: CycleCardProps) {
  const labels = useLabels();
  const { rollup, timing } = cycle;
  const { pill, kicker, current } = coverCopy(cycle);
  const closed = cycle.status === "CLOSED";
  const draft = cycle.status === "DRAFT";
  const running = cycle.status === "ACTIVE" && timing.phase === "running";
  // Not started yet: show the plan, not a 0% progress bar.
  const notStarted = timing.phase === "upcoming";
  const empty = rollup.objectiveCount === 0;
  const objectivesText = empty
    ? `No ${labels.objective.lowerPlural} yet`
    : plural(rollup.objectiveCount, labels.objective.lower, labels.objective.lowerPlural);

  return (
    <Link href={`/${orgSlug}/${workspaceSlug}/okrs/${cycle.id}`} className="wsx-tile okx-tile" data-closed={closed || undefined}>
      <WorkspaceCover name={cycle.title}>
        <CycleCoverText cycle={cycle} kicker={kicker} />
        <span className={current ? "wsx-pill wsx-pill-here" : "wsx-pill"}>{pill}</span>
      </WorkspaceCover>

      <div className="okx-tile-body">
        {draft || empty || notStarted ? (
          <>
            <div className="okx-chips">
              <span className="okx-chip" data-tone="plain">
                {empty ? `No ${labels.objective.lowerPlural} drafted yet` : draft ? "Draft plan" : "Not started"}
              </span>
              {!empty && (
                <span className="okx-chip" data-tone="plain">
                  <b>{rollup.objectiveCount}</b> {rollup.objectiveCount === 1 ? labels.objective.lower : labels.objective.lowerPlural} {draft ? "ready to review" : "planned"}
                </span>
              )}
            </div>
          </>
        ) : (
          <div className="okx-pace">
            <div className="okx-pace-top">
              <span className="okx-pace-pct">
                {rollup.progress}
                <small>%</small>
              </span>
              {running ? (
                <PaceNote progress={rollup.progress} elapsed={timing.percentElapsed} />
              ) : closed ? (
                <span className="okx-pace-note">Final average {labels.keyResult.lower} progress</span>
              ) : null}
            </div>
            <PaceTrack progress={rollup.progress} elapsed={running ? timing.percentElapsed : null} small />
          </div>
        )}
        {!draft && !empty && !notStarted && <StatusChips mix={rollup.statusMix} />}
      </div>

      <div className="wsx-tile-meta">
        <span>
          <Target className="wsx-icon" aria-hidden="true" />
          {objectivesText}
        </span>
        <span>
          <CalendarDays className="wsx-icon" aria-hidden="true" />
          {formatDateRange(cycle.startDate, cycle.endDate)}
        </span>
      </div>
    </Link>
  );
}
