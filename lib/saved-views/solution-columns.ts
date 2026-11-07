/**
 * What the Solutions status board shows per column, plus the resolved layout the
 * page hands to the board and the Columns popover. Pure: shared by server and client.
 */
import { DEFAULT_SOLUTION_COLUMN_ORDER, resolveColumns, type ColumnLayout } from "@/lib/saved-views/columns"
import { SOLUTION_BOARD_STATUSES } from "@/lib/saved-views/schema"
import { SOLUTION_STATUS } from "@/lib/solution-status"
import type { SolutionStatus } from "@/lib/types"

export type SolutionColumnAccent = "neutral" | "info" | "warning" | "success" | "danger"

export const SOLUTION_COLUMN_ACCENT: Record<SolutionStatus, SolutionColumnAccent> = {
  IDEA: "neutral",
  VALIDATED: "success",
  IN_DELIVERY: "info",
  SHIPPED: "warning",
  KILLED: "danger",
}

export function solutionColumnLabel(status: SolutionStatus): string {
  return SOLUTION_STATUS[status].label
}

export type SolutionColumns = {
  /** Every column in render order, hidden ones included (the Columns popover lists these). */
  order: SolutionStatus[]
  /** Columns the board renders. */
  visible: SolutionStatus[]
  /** Hidden by the layout but shown anyway because they hold cards. */
  forcedVisible: SolutionStatus[]
}

export function resolveSolutionColumns(
  layout: Partial<ColumnLayout> | undefined,
  countsByStatus: Readonly<Record<string, number>>,
): SolutionColumns {
  const resolved = resolveColumns(layout, SOLUTION_BOARD_STATUSES, DEFAULT_SOLUTION_COLUMN_ORDER, countsByStatus)
  return {
    order: resolved.order as SolutionStatus[],
    visible: resolved.visible as SolutionStatus[],
    forcedVisible: resolved.forcedVisible as SolutionStatus[],
  }
}
