import { describe, expect, it } from "vitest"
import { OPPORTUNITY_EXPORT_HEADER, buildOpportunityCsv, type OpportunityExportRow } from "@/lib/opportunity-export"

const row = (overrides: Partial<OpportunityExportRow> = {}): OpportunityExportRow => ({
  id: "opp1",
  title: "Slow checkout",
  status: "EXPLORING",
  customerSegment: "First-time buyers",
  squadName: "Growth",
  score: 72.5,
  solutionCount: 2,
  evidenceCount: 5,
  ...overrides,
})

const args = { origin: "https://compass.test", orgSlug: "acme", workspaceSlug: "ws" }

describe("buildOpportunityCsv", () => {
  it("writes the documented header and one row per opportunity with an absolute link", () => {
    const lines = buildOpportunityCsv([row()], args).replace("﻿", "").trim().split("\r\n")
    expect(lines[0]).toBe(OPPORTUNITY_EXPORT_HEADER.join(","))
    expect(lines[1]).toBe(
      "Slow checkout,EXPLORING,Growth,First-time buyers,72.5,2,5,https://compass.test/acme/ws/discovery/opp1"
    )
    expect(lines).toHaveLength(2)
  })

  it("leaves squad, segment and score empty when absent", () => {
    const csv = buildOpportunityCsv([row({ squadName: null, customerSegment: null, score: null })], args)
    expect(csv).toContain("Slow checkout,EXPLORING,,,,2,5,")
  })

  it("quotes and defuses hostile titles", () => {
    const csv = buildOpportunityCsv([row({ title: '=cmd|" /c calc"!A1, boom' })], args)
    expect(csv).toContain(`"'=cmd|"" /c calc""!A1, boom"`)
  })

  it("is header-only for no rows", () => {
    expect(buildOpportunityCsv([], args)).toBe(`﻿${OPPORTUNITY_EXPORT_HEADER.join(",")}\r\n`)
  })
})
