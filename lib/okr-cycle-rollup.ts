/**
 * Per-cycle rollup for the OKRs index and cycle detail banner.
 *
 * Pure and framework-free (no Prisma, no React), like lib/okrs.ts. Everything
 * is derived from data the pages already load, so no schema change is needed.
 */
import { averageProgress } from "@/lib/okrs";
import type { ObjectiveStatus } from "@/lib/types";

export interface RollupObjective {
  status: ObjectiveStatus | string;
  keyResults: Array<{ current: number; target: number }>;
}

export interface StatusMix {
  ON_TRACK: number;
  AT_RISK: number;
  OFF_TRACK: number;
  COMPLETE: number;
}

export interface CycleRollup {
  objectiveCount: number;
  keyResultCount: number;
  /** Mean of every KR's clamped progress, 0-100. 0 when there are no KRs. */
  progress: number;
  statusMix: StatusMix;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function emptyStatusMix(): StatusMix {
  return { ON_TRACK: 0, AT_RISK: 0, OFF_TRACK: 0, COMPLETE: 0 };
}

/** Roll up a cycle's objectives. KR progress is averaged across all KRs (not per objective) so large objectives weigh more. */
export function rollupObjectives(objectives: readonly RollupObjective[]): CycleRollup {
  const statusMix = emptyStatusMix();
  const allKrs: Array<{ current: number; target: number }> = [];
  for (const objective of objectives) {
    if (objective.status in statusMix) statusMix[objective.status as keyof StatusMix] += 1;
    allKrs.push(...objective.keyResults);
  }
  return {
    objectiveCount: objectives.length,
    keyResultCount: allKrs.length,
    progress: averageProgress(allKrs),
    statusMix,
  };
}

export interface CycleTiming {
  /** 0-100: how far through the cycle `now` is. 0 before start, 100 after end. */
  percentElapsed: number;
  /** Whole days until the end date, rounded up; 0 once ended. */
  daysLeft: number;
  /** Whole days until the start date, rounded up; 0 once started. */
  daysUntilStart: number;
  phase: "upcoming" | "running" | "ended";
}

/** Where `now` sits inside [start, end]. A degenerate (end <= start) range counts as fully elapsed once reached. */
export function cycleTiming(start: Date | string, end: Date | string, now: Date = new Date()): CycleTiming {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const nowMs = now.getTime();

  if (nowMs < startMs) {
    return { percentElapsed: 0, daysLeft: Math.max(0, Math.ceil((endMs - nowMs) / DAY_MS)), daysUntilStart: Math.ceil((startMs - nowMs) / DAY_MS), phase: "upcoming" };
  }
  if (nowMs > endMs) {
    return { percentElapsed: 100, daysLeft: 0, daysUntilStart: 0, phase: "ended" };
  }
  const span = endMs - startMs;
  const percentElapsed = span > 0 ? Math.round(((nowMs - startMs) / span) * 100) : 100;
  return { percentElapsed, daysLeft: Math.ceil((endMs - nowMs) / DAY_MS), daysUntilStart: 0, phase: "running" };
}

export type PaceVerdict = "ahead" | "on-pace" | "behind";

/**
 * Compare progress against the share of the cycle already elapsed. Within
 * `tolerance` percentage points counts as on pace.
 */
export function paceVerdict(progress: number, percentElapsed: number, tolerance = 10): PaceVerdict {
  const delta = progress - percentElapsed;
  if (delta > tolerance) return "ahead";
  if (delta < -tolerance) return "behind";
  return "on-pace";
}
