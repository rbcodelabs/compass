/** The DOC_SPECIFIES_SCOPE registry entry: exactly the decided shape, and nothing that would enforce cardinality. */
import { describe, expect, it } from "vitest"
import { ENTITY_TYPE_VOCABULARY } from "@/lib/entity-types"
import { DOC_SPECIFIES_SCOPE_LINK_TYPE, LINK_TYPES, defaultAuthorize, getLinkType, isLinkTypeEnabled, linkTypesForEntity, toTypesOf, validateLinkTypeDef } from "@/lib/links/registry"
import { DOC_TYPES, normalizeDocType } from "@/lib/doc-types"

describe("DOC_SPECIFIES_SCOPE", () => {
  const def = getLinkType("DOC_SPECIFIES_SCOPE")!

  it("is registered under its key", () => {
    expect(DOC_SPECIFIES_SCOPE_LINK_TYPE).toBe("DOC_SPECIFIES_SCOPE")
    expect(def).toBe(LINK_TYPES.DOC_SPECIFIES_SCOPE)
    expect(validateLinkTypeDef(def)).toEqual([])
  })

  it("links a DOC to a SOLUTION or an OPPORTUNITY, directed, with the decided labels", () => {
    expect(def.from).toBe("DOC")
    expect([...toTypesOf(def)]).toEqual(["SOLUTION", "OPPORTUNITY"])
    expect(def.direction).toBe("directed")
    expect(def.labels).toEqual({ forward: "Specifies", inverse: "Specified by" })
    for (const type of ["DOC", "SOLUTION", "OPPORTUNITY"]) expect(ENTITY_TYPE_VOCABULARY as readonly string[]).toContain(type)
  })

  it("does not enforce cardinality: many on both sides, no uniqueness beyond the pair", () => {
    expect(def.cardinality).toEqual({ from: "many", to: "many" })
    expect(def.duplicatePolicy).toBe("idempotent")
  })

  it("uses the default authorization and has no custom eligibility rule, flag, attrs or legacy adapter", () => {
    expect(def.authorize).toBe(defaultAuthorize)
    expect(def.eligible).toBeUndefined()
    expect(def.candidates).toBeUndefined()
    expect(def.isEnabled).toBeUndefined()
    expect(def.attrs).toBeUndefined()
    expect(def.legacy).toBeUndefined()
    expect(isLinkTypeEnabled(def)).toBe(true)
  })

  it("deletes the link when either end is deleted (the other end survives) and keeps it on archive", () => {
    expect(def.lifecycle).toEqual({ onFromDeleted: "delete", onToDeleted: "delete", onArchive: "keep" })
  })

  it("is readable from all three entity types through the generic list tool", () => {
    for (const type of ["DOC", "SOLUTION", "OPPORTUNITY"] as const) {
      expect(linkTypesForEntity(type).some((entry) => entry.def.key === "DOC_SPECIFIES_SCOPE")).toBe(true)
    }
  })
})

describe("SPEC doc type", () => {
  it("is a known type and survives normalisation, while unknown stored values still read as STANDARD", () => {
    expect(DOC_TYPES).toContain("SPEC")
    expect(normalizeDocType("SPEC")).toBe("SPEC")
    expect(normalizeDocType("nonsense")).toBe("STANDARD")
    expect(normalizeDocType(null)).toBe("STANDARD")
  })
})
