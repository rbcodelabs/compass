import { describe, expect, it } from "vitest"
import { buildFieldFacets, cellsMatchLabels, toCellValues, type FieldDefinitionInput } from "@/lib/roadmap-views/fields"

const def = (over: Partial<FieldDefinitionInput> & { id: string }): FieldDefinitionInput => ({
  workspaceId: "w1", name: "Status", fieldType: "SELECT", order: 0,
  options: [{ label: "On track", value: "on_track", color: "#0a0" }, { label: "At risk", value: "at_risk" }], ...over,
})

describe("buildFieldFacets", () => {
  it("merges same-name, same-type fields across workspaces (case-insensitive) into one facet", () => {
    const facets = buildFieldFacets([
      def({ id: "1", workspaceId: "w1" }),
      def({ id: "2", workspaceId: "w2", name: "status", options: [{ label: "at risk", value: "x", color: "#f00" }, { label: "Blocked", value: "blocked" }] }),
    ])
    expect(facets).toHaveLength(1)
    expect(facets[0]).toMatchObject({ key: "SELECT:status", name: "Status", definitionIds: ["1", "2"] })
    // Union by label; first-seen order; a colour is filled in when only a later definition has one.
    expect(facets[0].options).toEqual([{ label: "On track", color: "#0a0" }, { label: "At risk", color: "#f00" }, { label: "Blocked" }])
  })

  it("keeps the same name with a different type as a separate field", () => {
    const facets = buildFieldFacets([def({ id: "1" }), def({ id: "2", fieldType: "TEXT", options: [] })])
    expect(facets.map((f) => f.key).sort()).toEqual(["SELECT:status", "TEXT:status"])
  })
})

describe("toCellValues", () => {
  it("maps picklist option values to labels and keeps an unknown stored value as-is", () => {
    expect(toCellValues(def({ id: "1" }), "on_track")).toEqual([{ label: "On track", color: "#0a0" }])
    expect(toCellValues(def({ id: "1", fieldType: "MULTI_SELECT" }), ["at_risk", "gone"])).toEqual([{ label: "At risk" }, { label: "gone" }])
  })
  it("formats scalars and ignores empties", () => {
    const text = def({ id: "1", fieldType: "TEXT", options: [] })
    expect(toCellValues(text, "hello")).toEqual([{ label: "hello" }])
    expect(toCellValues(text, "  ")).toEqual([])
    expect(toCellValues(text, null)).toEqual([])
    expect(toCellValues(def({ id: "1", fieldType: "BOOLEAN", options: [] }), true)).toEqual([{ label: "Yes" }])
  })
})

describe("cellsMatchLabels", () => {
  it("matches any wanted label, case-insensitively", () => {
    expect(cellsMatchLabels([{ label: "At risk" }], ["blocked", "AT RISK"])).toBe(true)
    expect(cellsMatchLabels([{ label: "At risk" }], ["Blocked"])).toBe(false)
    expect(cellsMatchLabels([], ["Blocked"])).toBe(false)
  })
})
