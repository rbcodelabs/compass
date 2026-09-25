import { describe, expect, it } from "vitest"

import {
  addOptionLabels,
  moveOption,
  optionListIssues,
  renameOption,
  setOptionColor,
  splitPastedOptionLabels,
} from "@/lib/option-list"
import { normalizeSelectOptions } from "@/lib/shared-field-options"

/**
 * The option-list editor replaces a comma-separated text box that re-derived
 * every option's value from its label on each save. Renaming "Low" to "Minor"
 * therefore silently changed its stored value from "low" to "minor" and
 * orphaned every CustomFieldValue still holding "low" — and dropped colours,
 * which the text box never round-tripped. These helpers pin the opposite.
 */

describe("renameOption", () => {
  it("keeps an existing option's value when its label is renamed", () => {
    const renamed = renameOption([{ label: "Low", value: "low" }], 0, "Minor")
    expect(renamed).toEqual([{ label: "Minor", value: "low" }])
    expect(normalizeSelectOptions(renamed)).toEqual([{ label: "Minor", value: "low" }])
  })

  it("keeps the colour when only the label changes", () => {
    expect(renameOption([{ label: "Low", value: "low", color: "#16a34a" }], 0, "Minor")).toEqual([
      { label: "Minor", value: "low", color: "#16a34a" },
    ])
  })

  it("does not mutate the input list", () => {
    const input = [{ label: "Low", value: "low" }]
    renameOption(input, 0, "Minor")
    expect(input).toEqual([{ label: "Low", value: "low" }])
  })
})

describe("setOptionColor", () => {
  it("sets and clears a colour without touching label or value", () => {
    const colored = setOptionColor([{ label: "Low", value: "low" }], 0, "#dc2626")
    expect(colored).toEqual([{ label: "Low", value: "low", color: "#dc2626" }])
    expect(setOptionColor(colored, 0, null)).toEqual([{ label: "Low", value: "low" }])
  })
})

describe("moveOption", () => {
  const list = [
    { label: "A", value: "a" },
    { label: "B", value: "b" },
    { label: "C", value: "c", color: "#2563eb" },
  ]

  it("moves an option up and down, carrying its value and colour", () => {
    expect(moveOption(list, 2, 1).map((o) => o.value)).toEqual(["a", "c", "b"])
    expect(moveOption(list, 0, 1).map((o) => o.value)).toEqual(["b", "a", "c"])
    expect(moveOption(list, 2, 0)[0]).toEqual({ label: "C", value: "c", color: "#2563eb" })
  })

  it("is a no-op past either end", () => {
    expect(moveOption(list, 0, -1)).toEqual(list)
    expect(moveOption(list, 2, 3)).toEqual(list)
  })
})

describe("splitPastedOptionLabels", () => {
  it("splits multi-line text on newlines only, so labels may contain commas", () => {
    expect(splitPastedOptionLabels("Acme, Inc.\nGlobex\r\n\nInitech")).toEqual([
      "Acme, Inc.",
      "Globex",
      "Initech",
    ])
  })

  it("splits single-line text on commas", () => {
    expect(splitPastedOptionLabels("Low, Medium , High")).toEqual(["Low", "Medium", "High"])
  })

  it("strips list bullets from pasted lines", () => {
    expect(splitPastedOptionLabels("- Low\n* Medium\n• High\n1. Urgent")).toEqual([
      "Low",
      "Medium",
      "High",
      "Urgent",
    ])
  })

  it("drops a trailing comma from each pasted line", () => {
    expect(splitPastedOptionLabels("Low,\nMedium,\nHigh")).toEqual(["Low", "Medium", "High"])
  })

  it("returns nothing for blank text", () => {
    expect(splitPastedOptionLabels("  \n , ")).toEqual([])
  })
})

describe("addOptionLabels", () => {
  const existing = [{ label: "Low", value: "low" }]

  it("appends new options without a value so the server derives the slug", () => {
    const result = addOptionLabels(existing, ["Medium", " High "])
    expect(result.options).toEqual([{ label: "Low", value: "low" }, { label: "Medium" }, { label: "High" }])
    expect(result.duplicates).toEqual([])
  })

  it("reports duplicates (case-insensitive) instead of silently dropping them", () => {
    const result = addOptionLabels(existing, ["LOW", "Medium", "medium"])
    expect(result.options.map((o) => o.label)).toEqual(["Low", "Medium"])
    expect(result.duplicates).toEqual(["LOW", "medium"])
  })

  it("treats a label whose slug matches a renamed option's preserved value as a duplicate", () => {
    const renamed = [{ label: "Minor", value: "low" }]
    expect(addOptionLabels(renamed, ["Low"]).duplicates).toEqual(["Low"])
  })

  it("reports a blank submission", () => {
    expect(addOptionLabels(existing, ["   "])).toEqual({ options: existing, duplicates: [], blank: true })
  })
})

describe("optionListIssues", () => {
  it("returns no issues for a valid list", () => {
    expect(optionListIssues([{ label: "Low", value: "low" }, { label: "High" }])).toEqual([null, null])
  })

  it("flags blank labels", () => {
    expect(optionListIssues([{ label: " ", value: "low" }])).toEqual(["Label can't be blank"])
  })

  it("flags the later of two options sharing a derived value, case-insensitively", () => {
    expect(optionListIssues([{ label: "High" }, { label: "high" }])).toEqual([null, "Duplicate of “High”"])
  })

  it("flags a new option colliding with an existing option's preserved value", () => {
    expect(optionListIssues([{ label: "Minor", value: "low" }, { label: "Low" }])).toEqual([
      null,
      "Duplicate of “Minor”",
    ])
  })
})
