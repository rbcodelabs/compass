import { z } from "zod"

/**
 * Pure grid-layout math for the Metrics dashboard widget grid.
 *
 * Sizing is deliberate: with `grid-auto-rows: 64px` and a 16px gap, a small
 * card (col:1,row:2 = 144px) stacks exactly twice into a medium card's height
 * (col:2,row:4 = 304px = 2*144 + 16), and a large card is col:3,row:6 (464px).
 * Keep these numbers in sync with the CSS grid constants the client renders
 * with -- they are load-bearing for two small cards to pack cleanly beside a
 * medium one instead of leaving a gap or overlapping it.
 */
export const DASHBOARD_GRID = { cols: 4, colMin: 1, colMax: 4, rowMin: 2, rowMax: 6 } as const

export type SizeBucket = "sm" | "md" | "lg"

export const SIZE_PRESET: Record<SizeBucket, { col: number; row: number }> = {
  sm: { col: 1, row: 2 },
  md: { col: 2, row: 4 },
  lg: { col: 3, row: 6 },
}

/** The default layout for a metric that has never been sized (new, or re-added from "Add widget"). */
export const DEFAULT_LAYOUT = SIZE_PRESET.md

/** The full default dashboard state for a metric row whose layout columns are still NULL. */
export const DEFAULT_DASHBOARD_STATE = { visible: true, col: SIZE_PRESET.md.col, row: SIZE_PRESET.md.row, sortOrder: 0 } as const

export function sizeBucket(col: number, row: number): SizeBucket {
  if (col <= 1 && row <= 2) return "sm"
  if (col <= 2 && row <= 4) return "md"
  return "lg"
}

/** Clamps a freeform resize to the supported grid range, rounding to whole tracks. */
export function clampLayout(input: { col: number; row: number }): { col: number; row: number } {
  const col = Math.min(DASHBOARD_GRID.colMax, Math.max(DASHBOARD_GRID.colMin, Math.round(input.col)))
  const row = Math.min(DASHBOARD_GRID.rowMax, Math.max(DASHBOARD_GRID.rowMin, Math.round(input.row)))
  return { col, row }
}

export const dashboardLayoutInputSchema = z.object({ col: z.number().finite(), row: z.number().finite() }).strict()
export type DashboardLayoutInput = z.infer<typeof dashboardLayoutInputSchema>

export const dashboardSortOrderSchema = z.number().finite().int()
