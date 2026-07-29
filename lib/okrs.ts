/**
 * Shared, framework-free OKR helpers.
 *
 * Extracted from components/okrs/objective-row.tsx and
 * components/okrs/key-result-bar.tsx so both the OKRs page and the Canvas
 * viewer (lib/canvas/*) render identical progress math and status styling
 * without duplicating it. Pure — no Prisma, no React — trivial to unit test.
 */
import type { ObjectiveStatus } from "@/lib/types";

export interface KeyResultProgressInput {
  current: number;
  target: number;
}

/** Clamps a single KR's progress to [0, 100]. target === 0 is treated as 0% (undefined ratio). */
export function clampProgress(current: number, target: number): number {
  if (target === 0) return 0;
  return Math.min(100, Math.max(0, Math.round((current / target) * 100)));
}

/** Averages clamped per-KR progress across an Objective's Key Results. */
export function averageProgress(keyResults: KeyResultProgressInput[]): number {
  if (keyResults.length === 0) return 0;
  const total = keyResults.reduce((sum, kr) => {
    if (kr.target === 0) return sum;
    return sum + Math.min(100, Math.max(0, (kr.current / kr.target) * 100));
  }, 0);
  return Math.round(total / keyResults.length);
}

export const STATUS_BADGE: Record<
  ObjectiveStatus,
  { label: string; className: string }
> = {
  ON_TRACK: {
    label: "On track",
    className:
      "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  },
  AT_RISK: {
    label: "At risk",
    className:
      "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
  },
  OFF_TRACK: {
    label: "Off track",
    className:
      "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  },
  COMPLETE: {
    label: "Complete",
    className:
      "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  },
};
