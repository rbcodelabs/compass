import { describe, expect, it } from "vitest"
import {
  DEFAULT_OPPORTUNITY_STATUS,
  OPPORTUNITY_LIFECYCLE_STATUSES,
  OPPORTUNITY_PIPELINE_STATUSES,
  OPPORTUNITY_PIPELINE_TEXT,
  OPPORTUNITY_STATUSES,
  OPPORTUNITY_STATUS_DEFINITIONS,
  isOpportunityStatus,
  opportunityStatusLabel,
  opportunityStatusTooltip,
} from "@/lib/opportunity-status"
import { OPPORTUNITY_STATUS_BADGE } from "@/lib/discovery"
import { EMPTY_OPPORTUNITY_DRAFT, NEW_OPPORTUNITY_STATUSES, isNewOpportunityStatus } from "@/lib/opportunity-draft"
import { normalizeNewOpportunityInput } from "@/lib/opportunity-create"
import { DEFAULT_OPPORTUNITY_COLUMN_ORDER, resolveColumns } from "@/lib/saved-views/columns"
import { OPPORTUNITY_COLUMN_META } from "@/lib/saved-views/opportunity-columns"
import { OPPORTUNITY_BOARD_STATUSES } from "@/lib/saved-views/schema"

describe("opportunity status definitions", () => {
  it("shows Unreviewed after the other board columns while the lifecycle still starts there", () => {
    expect([...OPPORTUNITY_STATUSES]).toEqual(["EXPLORING", "VALIDATING", "PRIORITIZED", "ACTIVE", "UNREVIEWED", "ARCHIVED"])
    expect([...OPPORTUNITY_PIPELINE_STATUSES]).toEqual(["EXPLORING", "VALIDATING", "PRIORITIZED", "ACTIVE", "UNREVIEWED"])
    expect([...OPPORTUNITY_LIFECYCLE_STATUSES]).toEqual(["UNREVIEWED", "EXPLORING", "VALIDATING", "PRIORITIZED", "ACTIVE", "ARCHIVED"])
    expect(OPPORTUNITY_PIPELINE_TEXT).toBe("UNREVIEWED → EXPLORING → VALIDATING → PRIORITIZED → ACTIVE → ARCHIVED")
  })

  it("gives every status a label, tone, badge, definition and entry criterion", () => {
    for (const status of OPPORTUNITY_STATUSES) {
      const d = OPPORTUNITY_STATUS_DEFINITIONS[status]
      expect(d.label.length).toBeGreaterThan(0)
      expect(d.tone).toBeTruthy()
      expect(d.graphTone).toBeTruthy()
      expect(d.badgeClassName).toBeTruthy()
      expect(d.triggerClassName).toBeTruthy()
      expect(d.definition.length).toBeGreaterThan(20)
      expect(d.entryCriterion.length).toBeGreaterThan(20)
      expect(opportunityStatusTooltip(status)).toContain(d.definition)
    }
  })

  it("labels UNREVIEWED as Unreviewed and falls back to the raw value for unknown statuses", () => {
    expect(opportunityStatusLabel("UNREVIEWED")).toBe("Unreviewed")
    expect(opportunityStatusLabel("MYSTERY")).toBe("MYSTERY")
    expect(isOpportunityStatus("UNREVIEWED")).toBe(true)
    expect(isOpportunityStatus("NOPE")).toBe(false)
  })

  it("makes UNREVIEWED the default for every creation path", () => {
    expect(DEFAULT_OPPORTUNITY_STATUS).toBe("UNREVIEWED")
    expect(EMPTY_OPPORTUNITY_DRAFT.status).toBe("UNREVIEWED")
    const result = normalizeNewOpportunityInput({ title: "Checkout is slow" })
    expect(result.ok && result.data.status).toBe("UNREVIEWED")
  })

  it("lets a caller still pick any pipeline status but never ARCHIVED", () => {
    expect([...NEW_OPPORTUNITY_STATUSES]).toEqual([...OPPORTUNITY_PIPELINE_STATUSES])
    expect(isNewOpportunityStatus("UNREVIEWED")).toBe(true)
    expect(isNewOpportunityStatus("EXPLORING")).toBe(true)
    expect(isNewOpportunityStatus("ARCHIVED")).toBe(false)
    const explicit = normalizeNewOpportunityInput({ title: "Triaged already", status: "EXPLORING" })
    expect(explicit.ok && explicit.data.status).toBe("EXPLORING")
  })

  it("drives the badge and board-column metadata from the same map", () => {
    for (const status of OPPORTUNITY_STATUSES) {
      expect(OPPORTUNITY_STATUS_BADGE[status].label).toBe(OPPORTUNITY_STATUS_DEFINITIONS[status].label)
      expect(OPPORTUNITY_COLUMN_META[status].label).toBe(OPPORTUNITY_STATUS_DEFINITIONS[status].label)
    }
  })

  it("puts UNREVIEWED last on the board and still resolves saved layouts that omit it", () => {
    expect([...OPPORTUNITY_BOARD_STATUSES]).toEqual([...OPPORTUNITY_PIPELINE_STATUSES])
    expect(DEFAULT_OPPORTUNITY_COLUMN_ORDER.at(-1)).toBe("UNREVIEWED")
    // A view saved before UNREVIEWED existed: it is appended, not dropped or crashing.
    const legacy = resolveColumns({ order: ["EXPLORING", "VALIDATING", "PRIORITIZED", "ACTIVE"] }, OPPORTUNITY_BOARD_STATUSES, DEFAULT_OPPORTUNITY_COLUMN_ORDER, {})
    expect(legacy.order).toEqual(["EXPLORING", "VALIDATING", "PRIORITIZED", "ACTIVE", "UNREVIEWED"])
    expect(legacy.visible).toContain("UNREVIEWED")
  })
})
