/**
 * The single source of truth for Opportunity statuses: order, label, tone,
 * badge styling, and a plain-language definition plus entry criterion.
 *
 * Every surface that lists or explains statuses (board column headers, status
 * dropdowns, card badges, the discovery rail, MCP/REST schemas and tool
 * descriptions, docs) derives from this module so the definitions cannot
 * drift apart. Pure: no React, no Prisma.
 *
 * Pipeline: UNREVIEWED -> EXPLORING -> VALIDATING -> PRIORITIZED -> ACTIVE
 * (-> ARCHIVED, which is not a pipeline stage and not a board column).
 */
import type { OpportunityStatus } from "@/lib/types"

/** Every status, in pipeline order, ARCHIVED last. */
export const OPPORTUNITY_STATUSES = ["UNREVIEWED", "EXPLORING", "VALIDATING", "PRIORITIZED", "ACTIVE", "ARCHIVED"] as const satisfies readonly OpportunityStatus[]

/** Statuses that are pipeline stages (board columns); everything but ARCHIVED. */
export const OPPORTUNITY_PIPELINE_STATUSES = ["UNREVIEWED", "EXPLORING", "VALIDATING", "PRIORITIZED", "ACTIVE"] as const satisfies readonly OpportunityStatus[]

/**
 * The status every newly created opportunity gets unless the caller picks one
 * (composer, board "add", table draft, MCP, REST, feedback promotion).
 *
 * The Prisma column default is deliberately still "EXPLORING": changing a
 * column default needs an `ALTER COLUMN SET DEFAULT` that Aurora DSQL does not
 * support, and existing rows must not change. Application code always passes
 * this value explicitly instead.
 */
export const DEFAULT_OPPORTUNITY_STATUS = "UNREVIEWED" as const satisfies OpportunityStatus

export type OpportunityTone = "neutral" | "info" | "warning" | "success"

export type OpportunityStatusDefinition = {
  label: string
  /** Semantic tone for board column accents. */
  tone: OpportunityTone
  /** Tone used for the node in the chain graph. */
  graphTone: OpportunityTone
  /** Tailwind classes for a compact pill (no border). */
  badgeClassName: string
  /** Tailwind classes for a bordered status select trigger (opportunity header). */
  triggerClassName: string
  /** One sentence: what this status means. */
  definition: string
  /** One sentence: what must be true to move an opportunity into this status. */
  entryCriterion: string
}

export const OPPORTUNITY_STATUS_DEFINITIONS = {
  UNREVIEWED: {
    label: "Unreviewed",
    tone: "neutral",
    graphTone: "neutral",
    badgeClassName: "bg-slate-100 text-slate-600",
    triggerClassName: "bg-slate-100 text-slate-600 border-slate-200",
    definition: "Raw and captured, but nobody has triaged it yet; this is the inbox.",
    entryCriterion: "Entered by default whenever an opportunity is created.",
  },
  EXPLORING: {
    label: "Exploring",
    tone: "neutral",
    graphTone: "neutral",
    badgeClassName: "bg-violet-100 text-violet-700",
    triggerClassName: "bg-violet-100 text-violet-700 border-violet-200",
    definition: "Triaged and worth understanding; you are gathering first customer signal, with no evidence bar yet.",
    entryCriterion: "Someone has triaged it and decided the problem is worth a closer look.",
  },
  VALIDATING: {
    label: "Validating",
    tone: "warning",
    graphTone: "info",
    badgeClassName: "bg-amber-100 text-amber-700",
    triggerClassName: "bg-amber-100 text-amber-700 border-amber-200",
    definition: "Promising; you are actively collecting evidence through interviews and experiments to confirm its size and frequency.",
    entryCriterion: "Early signal suggests a real, recurring problem and you have started gathering evidence.",
  },
  PRIORITIZED: {
    label: "Prioritized",
    tone: "info",
    graphTone: "info",
    badgeClassName: "bg-blue-100 text-blue-700",
    triggerClassName: "bg-blue-100 text-blue-700 border-blue-200",
    definition: "Validated and selected for investment; the team is working out solutions.",
    entryCriterion: "The evidence confirms the problem is big and frequent enough, and the team has chosen to invest in it.",
  },
  ACTIVE: {
    label: "Active",
    tone: "success",
    graphTone: "success",
    badgeClassName: "bg-green-100 text-green-700",
    triggerClassName: "bg-green-100 text-green-700 border-green-200",
    definition: "Being built toward right now; keep this to one or two opportunities at a time.",
    entryCriterion: "A solution is in delivery and the team is working on it this cycle.",
  },
  ARCHIVED: {
    label: "Archived",
    tone: "neutral",
    graphTone: "neutral",
    badgeClassName: "bg-slate-100 text-slate-400",
    triggerClassName: "bg-surface-inset text-text-subtle border-border-default",
    definition: "Closed out: done, no longer relevant, or deliberately dropped. Hidden from the board.",
    entryCriterion: "The opportunity is resolved or will not be pursued.",
  },
} as const satisfies Record<OpportunityStatus, OpportunityStatusDefinition>

export function isOpportunityStatus(value: unknown): value is OpportunityStatus {
  return typeof value === "string" && (OPPORTUNITY_STATUSES as readonly string[]).includes(value)
}

/** Label for a status; unknown values fall back to the raw string. */
export function opportunityStatusLabel(status: string): string {
  return isOpportunityStatus(status) ? OPPORTUNITY_STATUS_DEFINITIONS[status].label : status
}

/** "Triaged and worth understanding... Enter when: ..." for tooltips. */
export function opportunityStatusTooltip(status: OpportunityStatus): string {
  const d = OPPORTUNITY_STATUS_DEFINITIONS[status]
  return `${d.definition} ${d.entryCriterion}`
}

/** "UNREVIEWED → EXPLORING → ..." for MCP tool descriptions and docs. */
export const OPPORTUNITY_PIPELINE_TEXT = [...OPPORTUNITY_PIPELINE_STATUSES, "ARCHIVED"].join(" → ")

/** One line per status, for embedding in MCP tool descriptions. */
export const OPPORTUNITY_STATUS_GUIDE = OPPORTUNITY_STATUSES.map(
  (s) => `${s}: ${OPPORTUNITY_STATUS_DEFINITIONS[s].definition}`,
).join(" ")
