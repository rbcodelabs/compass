import { describe, expect, it } from "vitest"
import { parseGroupByParam, resolveRoadmapGroupBy } from "@/lib/roadmap-group-by"
import type { CustomFieldDefinitionData } from "@/lib/types"

const selectField: CustomFieldDefinitionData = {
  id: "field-select",
  name: "Product Area",
  fieldType: "SELECT",
  objectType: "ROADMAP_ITEM",
  options: [{ label: "Payments", value: "payments" }],
  sharedOptionSetId: null,
  sharedOptionSetName: null,
  required: false,
  order: 0,
}

const multiSelectField: CustomFieldDefinitionData = {
  ...selectField,
  id: "field-multi",
  fieldType: "MULTI_SELECT",
}

describe("parseGroupByParam", () => {
  it("treats an absent param and the literal 'phase' as Phase", () => {
    expect(parseGroupByParam(undefined)).toBe("phase")
    expect(parseGroupByParam("phase")).toBe("phase")
  })

  it("recognizes the squad and none literals", () => {
    expect(parseGroupByParam("squad")).toBe("squad")
    expect(parseGroupByParam("none")).toBe("none")
  })

  it("treats anything else as a candidate custom field id", () => {
    expect(parseGroupByParam("field-select")).toEqual({ customFieldId: "field-select" })
  })

  it("takes the first value when Next hands back an array", () => {
    expect(parseGroupByParam(["squad", "none"])).toBe("squad")
  })
})

describe("resolveRoadmapGroupBy", () => {
  it("resolves phase/squad/none without needing field definitions", () => {
    expect(resolveRoadmapGroupBy("phase", [])).toEqual({ mode: "phase" })
    expect(resolveRoadmapGroupBy("squad", [])).toEqual({ mode: "squad" })
    expect(resolveRoadmapGroupBy("none", [])).toEqual({ mode: "none" })
  })

  it("resolves a matching SELECT field id to customField mode", () => {
    expect(resolveRoadmapGroupBy({ customFieldId: "field-select" }, [selectField])).toEqual({
      mode: "customField",
      field: selectField,
    })
  })

  it("falls back to Phase for a MULTI_SELECT field id — out of scope for grouping", () => {
    expect(resolveRoadmapGroupBy({ customFieldId: "field-multi" }, [multiSelectField])).toEqual({ mode: "phase" })
  })

  it("falls back to Phase for an unknown or deleted field id", () => {
    expect(resolveRoadmapGroupBy({ customFieldId: "deleted-field" }, [selectField])).toEqual({ mode: "phase" })
  })
})
