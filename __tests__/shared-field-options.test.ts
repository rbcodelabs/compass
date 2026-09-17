import { describe, it, expect } from "vitest";
import {
  SHARED_OPTION_SET_FIELD_TYPES,
  supportsSharedOptionSet,
  parseSelectOptions,
  normalizeSelectOptions,
  optionsFromCommaList,
  resolveEffectiveOptions,
  customFieldValueMatches,
} from "@/lib/shared-field-options";

describe("supportsSharedOptionSet", () => {
  it("accepts exactly SELECT and MULTI_SELECT", () => {
    expect([...SHARED_OPTION_SET_FIELD_TYPES]).toEqual(["SELECT", "MULTI_SELECT"]);
    expect(supportsSharedOptionSet("SELECT")).toBe(true);
    expect(supportsSharedOptionSet("MULTI_SELECT")).toBe(true);
  });

  it("rejects every other field type", () => {
    for (const fieldType of ["TEXT", "NUMBER", "DATE", "URL", "BOOLEAN"] as const) {
      expect(supportsSharedOptionSet(fieldType)).toBe(false);
    }
  });
});

describe("parseSelectOptions", () => {
  it("reads a well-formed JSON options array", () => {
    expect(
      parseSelectOptions([
        { label: "Payments", value: "payments", color: "#ff0000" },
        { label: "Billing", value: "billing" },
      ])
    ).toEqual([
      { label: "Payments", value: "payments", color: "#ff0000" },
      { label: "Billing", value: "billing" },
    ]);
  });

  it("returns an empty list for null, undefined, and non-arrays", () => {
    expect(parseSelectOptions(null)).toEqual([]);
    expect(parseSelectOptions(undefined)).toEqual([]);
    expect(parseSelectOptions("payments")).toEqual([]);
    expect(parseSelectOptions({ label: "Payments", value: "payments" })).toEqual([]);
  });

  it("drops malformed entries instead of throwing", () => {
    expect(
      parseSelectOptions([
        { label: "Payments", value: "payments" },
        null,
        42,
        { label: "No value" },
        { value: "no-label" },
      ])
    ).toEqual([{ label: "Payments", value: "payments" }]);
  });

  it("omits a colour that is not a string", () => {
    expect(parseSelectOptions([{ label: "A", value: "a", color: 5 }])).toEqual([
      { label: "A", value: "a" },
    ]);
  });
});

describe("normalizeSelectOptions", () => {
  it("trims labels and derives a slug value when none is supplied", () => {
    expect(normalizeSelectOptions([{ label: "  Growth Platform  " }])).toEqual([
      { label: "Growth Platform", value: "growth_platform" },
    ]);
  });

  it("keeps an explicitly supplied value untouched", () => {
    expect(normalizeSelectOptions([{ label: "Payments", value: "PAY-1" }])).toEqual([
      { label: "Payments", value: "PAY-1" },
    ]);
  });

  it("drops entries with a blank label", () => {
    expect(normalizeSelectOptions([{ label: "   " }, { label: "Keep" }])).toEqual([
      { label: "Keep", value: "keep" },
    ]);
  });

  it("de-duplicates by value, first occurrence wins", () => {
    expect(
      normalizeSelectOptions([
        { label: "Payments", value: "payments" },
        { label: "Payments Renamed", value: "payments" },
        { label: "Billing", value: "billing" },
      ])
    ).toEqual([
      { label: "Payments", value: "payments" },
      { label: "Billing", value: "billing" },
    ]);
  });

  it("preserves colours", () => {
    expect(normalizeSelectOptions([{ label: "A", color: "#123456" }])).toEqual([
      { label: "A", value: "a", color: "#123456" },
    ]);
  });
});

describe("optionsFromCommaList", () => {
  it("splits, trims and slugs a comma separated list", () => {
    expect(optionsFromCommaList("Low, Medium , High")).toEqual([
      { label: "Low", value: "low" },
      { label: "Medium", value: "medium" },
      { label: "High", value: "high" },
    ]);
  });

  it("returns an empty list for an empty string", () => {
    expect(optionsFromCommaList("   ")).toEqual([]);
  });
});

describe("resolveEffectiveOptions", () => {
  const shared = {
    id: "set-1",
    name: "Product Area",
    options: [{ label: "Payments", value: "payments" }],
  };

  it("uses the shared set's options when the field is attached", () => {
    expect(
      resolveEffectiveOptions({
        fieldType: "MULTI_SELECT",
        options: [{ label: "Stale local", value: "stale" }],
        sharedOptionSet: shared,
      })
    ).toEqual([{ label: "Payments", value: "payments" }]);
  });

  it("falls back to the local options when there is no shared set", () => {
    expect(
      resolveEffectiveOptions({
        fieldType: "SELECT",
        options: [{ label: "Local", value: "local" }],
        sharedOptionSet: null,
      })
    ).toEqual([{ label: "Local", value: "local" }]);
  });

  it("returns an empty list for a non-select field type", () => {
    expect(
      resolveEffectiveOptions({
        fieldType: "TEXT",
        options: [{ label: "Local", value: "local" }],
        sharedOptionSet: null,
      })
    ).toEqual([]);
  });

  it("returns an empty list when neither source has options", () => {
    expect(
      resolveEffectiveOptions({ fieldType: "SELECT", options: null, sharedOptionSet: null })
    ).toEqual([]);
  });
});

describe("customFieldValueMatches", () => {
  it("matches a MULTI_SELECT array by containment, not equality", () => {
    expect(customFieldValueMatches(["payments", "billing"], "billing")).toBe(true);
    expect(customFieldValueMatches(["payments", "billing"], "payments")).toBe(true);
  });

  it("does not match a value absent from the array", () => {
    expect(customFieldValueMatches(["payments"], "billing")).toBe(false);
  });

  it("does not match on a prefix or substring of an array member", () => {
    expect(customFieldValueMatches(["payments_legacy"], "payments")).toBe(false);
  });

  it("matches a SELECT scalar by exact equality", () => {
    expect(customFieldValueMatches("payments", "payments")).toBe(true);
    expect(customFieldValueMatches("payments", "billing")).toBe(false);
  });

  it("ignores non-string array members rather than coercing them", () => {
    expect(customFieldValueMatches([1, true, "payments"], "payments")).toBe(true);
    expect(customFieldValueMatches([1, true], "1")).toBe(false);
  });

  it("never matches null, empty arrays, numbers or booleans", () => {
    expect(customFieldValueMatches(null, "payments")).toBe(false);
    expect(customFieldValueMatches([], "payments")).toBe(false);
    expect(customFieldValueMatches(7, "7")).toBe(false);
    expect(customFieldValueMatches(true, "true")).toBe(false);
  });

  it("never matches an empty wanted value", () => {
    expect(customFieldValueMatches(["payments"], "")).toBe(false);
    expect(customFieldValueMatches("", "")).toBe(false);
  });
});
