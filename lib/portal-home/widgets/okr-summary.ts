import { z } from "zod"
import { requiredText, uuidLike } from "../fields"

export const OKR_SUMMARY_MAX_OBJECTIVES = 8
export const OKR_SUMMARY_MODES = ["active", "cycle", "selected"] as const

/**
 * Team-only OKR progress card. "active" shows the active cycle's objectives, "cycle" a chosen cycle's, and
 * "selected" only the chosen objectives (any cycle), in the admin's order, dropping any that no longer exist.
 * Add several of these widgets for different cycles or groups of objectives. OKRs are internal, so the customer
 * resolver never returns data for this widget (see resolvers/okr-summary.ts).
 */
export const okrSummaryConfig = z.object({
  title: requiredText(80),
  maxObjectives: z.number().int().min(1).max(OKR_SUMMARY_MAX_OBJECTIVES).default(4),
  mode: z.enum(OKR_SUMMARY_MODES).default("active"),
  cycleId: uuidLike.nullable().default(null),
  objectiveIds: z.array(uuidLike).max(OKR_SUMMARY_MAX_OBJECTIVES).default([]),
})
export type OkrSummaryConfig = z.infer<typeof okrSummaryConfig>

export const okrSummaryDefinition = {
  type: "okr_summary" as const,
  label: "OKRs",
  description: "Objectives and key result progress (team only)",
  defaultSize: "M" as const,
  configSchema: okrSummaryConfig,
  defaultConfig: (): OkrSummaryConfig => ({ title: "OKRs", maxObjectives: 4, mode: "active", cycleId: null, objectiveIds: [] }),
}
