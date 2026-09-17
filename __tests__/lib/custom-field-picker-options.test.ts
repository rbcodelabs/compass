import { describe, expect, it } from "vitest"
import { pickerOptions, toStoredOptionValues } from "@/lib/shared-field-options"

/**
 * The value editor persists option *values* (slugs) while only ever showing
 * option *labels*. These two helpers are the seam where a stored value meets
 * the list it is supposed to have come from, so they own the two ways that
 * pairing can go wrong: a value the list no longer offers, and a stored shape
 * the old free-text editor could produce but a picklist never should.
 */

const options = [
  { label: "ZZ Alpha", value: "zz_alpha" },
  { label: "ZZ Beta", value: "zz_beta", color: "#ff0000" },
]

describe("toStoredOptionValues", () => {
  it("reads a SELECT's bare string as a one-value list", () => {
    expect(toStoredOptionValues("zz_alpha")).toEqual(["zz_alpha"])
  })

  it("reads a MULTI_SELECT's array as-is", () => {
    expect(toStoredOptionValues(["zz_alpha", "zz_beta"])).toEqual(["zz_alpha", "zz_beta"])
  })

  it("treats null, undefined and the empty string as no value", () => {
    expect(toStoredOptionValues(null)).toEqual([])
    expect(toStoredOptionValues(undefined)).toEqual([])
    expect(toStoredOptionValues("")).toEqual([])
    expect(toStoredOptionValues([])).toEqual([])
  })

  it("drops non-string members rather than coercing them into fake option values", () => {
    expect(toStoredOptionValues([1, null, "zz_alpha", true, { value: "x" }])).toEqual(["zz_alpha"])
    expect(toStoredOptionValues(42)).toEqual([])
    expect(toStoredOptionValues(true)).toEqual([])
  })

  it("de-duplicates, because one object cannot carry the same option twice", () => {
    expect(toStoredOptionValues(["zz_alpha", "zz_alpha", "zz_beta"])).toEqual([
      "zz_alpha",
      "zz_beta",
    ])
  })
})

describe("pickerOptions", () => {
  it("returns the field's own options untouched when every stored value matches one", () => {
    expect(pickerOptions(options, ["zz_alpha"])).toEqual(options)
  })

  it("keeps offering the full list even when nothing is stored", () => {
    expect(pickerOptions(options, [])).toEqual(options)
  })

  it("appends a stale entry for a stored value the list no longer offers", () => {
    // The whole point: a value written by the old free-text editor, or one
    // deleted from a shared set since, must stay visible and removable rather
    // than vanish from the editor while still sitting in the database.
    expect(pickerOptions(options, ["zz_alpha", "ZZ Gamma"])).toEqual([
      ...options,
      { label: "ZZ Gamma", value: "ZZ Gamma", stale: true },
    ])
  })

  it("orders stale entries after real ones, in stored order", () => {
    expect(pickerOptions(options, ["legacy_b", "legacy_a"]).map((o) => o.value)).toEqual([
      "zz_alpha",
      "zz_beta",
      "legacy_b",
      "legacy_a",
    ])
  })

  it("treats a field with no options at all as one where everything stored is stale", () => {
    expect(pickerOptions(null, ["ZZ Alpha"])).toEqual([
      { label: "ZZ Alpha", value: "ZZ Alpha", stale: true },
    ])
    expect(pickerOptions(null, [])).toEqual([])
  })

  it("never lists the same value twice", () => {
    expect(pickerOptions(options, ["zz_alpha", "zz_alpha"]).map((o) => o.value)).toEqual([
      "zz_alpha",
      "zz_beta",
    ])
  })
})
