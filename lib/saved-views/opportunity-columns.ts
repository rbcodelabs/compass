/**
 * What the Opportunities status board shows per column, plus the resolved layout the
 * page hands to the board and the Columns popover. Pure: shared by server and client.
 */
import { DEFAULT_OPPORTUNITY_COLUMN_ORDER, resolveColumns, type ColumnLayout, type ResolvedColumns } from "@/lib/saved-views/columns"
import { OPPORTUNITY_BOARD_STATUSES } from "@/lib/saved-views/schema"
import type { OpportunityStatus } from "@/lib/types"

export type ColumnAccent = "neutral" | "info" | "warning" | "success"

export const OPPORTUNITY_COLUMN_META: Record<OpportunityStatus, { label: string; accent: ColumnAccent }> = {
  ACTIVE: { label: "Active", accent: "success" },
  PRIORITIZED: { label: "Prioritized", accent: "info" },
  VALIDATING: { label: "Validating", accent: "warning" },
  EXPLORING: { label: "Exploring", accent: "neutral" },
  // Not a board column; present so the record is total over OpportunityStatus.
  ARCHIVED: { label: "Archived", accent: "neutral" },
}

export type OpportunityColumns = {
  /** Every column in render order, hidden ones included (the Columns popover lists these). */
  order: OpportunityStatus[]
  /** Columns the board renders. */
  visible: OpportunityStatus[]
  /** Hidden by the layout but shown anyway because they hold cards. */
  forcedVisible: OpportunityStatus[]
}

/** Resolves the status layout against live card counts; the single call both the page and the popover rely on. */
export function resolveOpportunityColumns(
  layout: Partial<ColumnLayout> | undefined,
  countsByStatus: Readonly<Record<string, number>>,
): OpportunityColumns {
  const resolved: ResolvedColumns = resolveColumns(layout, OPPORTUNITY_BOARD_STATUSES, DEFAULT_OPPORTUNITY_COLUMN_ORDER, countsByStatus)
  return {
    order: resolved.order as OpportunityStatus[],
    visible: resolved.visible as OpportunityStatus[],
    forcedVisible: resolved.forcedVisible as OpportunityStatus[],
  }
}

/** The order the board uses when nothing is configured. */
export const DEFAULT_VISIBLE_COLUMNS: readonly OpportunityStatus[] = DEFAULT_OPPORTUNITY_COLUMN_ORDER
