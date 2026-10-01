import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { CONVERTED_FILES } from "./converted-files"
import { copyFragments, substitute } from "./copy-extract"
import { resolveThinkingModel } from "@/lib/thinking-model/resolve"
import { linkPlaceholder, linkToPlaceholder, linkedToLabel } from "@/lib/thinking-model/copy"
import { panelTitles } from "@/components/panels/panel-titles"
import { linkedTypeLabels, linkedTypePluralLabels } from "@/components/tasks/linked-type-labels"
import { objectTypeLabels } from "@/components/custom-fields/object-type-labels"

/**
 * Under CLASSIC (NULL) every piece of entity copy that origin/main shipped in the
 * converted files must still be producible, string for string.
 *
 * Expected side: classic-copy.main.json, extracted from ORIGIN/MAIN'S source by
 * scripts/regenerate-thinking-model-baselines.ts (never from this branch).
 * Actual side: the same extractor over THIS branch's source, with each
 * `labels.x.y` expression replaced by its real CLASSIC value, plus the output of
 * the real helper functions that now produce strings that used to be literals
 * (panel titles, link-type names, object-type names, article phrases).
 *
 * This is what pins surfaces the render snapshot (classic-text.test.tsx) cannot
 * reach: sidebar, the okrs and cycle pages, key-result-bar, objective-row,
 * objectives-list, check-in-form, panel-shell, roadmap-item-panel, the composer,
 * the discovery rail, the metrics page and dashboard, the settings page.
 *
 * Limits: text extraction, not rendering. A string rebuilt with different
 * surrounding expressions (see EXCEPTIONS) is pinned by a rendered case instead.
 */

const ROOT = process.cwd()
const CLASSIC = resolveThinkingModel({ thinkingModel: null }).labels
const mainCopy = JSON.parse(readFileSync(path.join(ROOT, "__tests__/thinking-model/classic-copy.main.json"), "utf-8")) as {
  mainSha: string
  files: Record<string, string[]>
}

/** Main's fragments that this branch builds differently; each is pinned by a rendered case instead. */
const EXCEPTIONS: Record<string, string> = {
  "{} objective{}": "cycle-card.tsx pluralises with a ternary now; pinned by 'cycle-card 0/1/3' in classic-text.test.tsx",
}

// A bare `{labels.keyResult.sentence}` cannot be traced by text, so every form of
// every label counts as producible. Where it matters, the rendered cases pin it.
const labelValues = (): string[] => Object.values(CLASSIC).flatMap((entry) => Object.values(entry))

const helperOutputs = (): string[] => [
  ...labelValues(),
  ...Object.values(panelTitles(CLASSIC)),
  ...Object.values(linkedTypeLabels(CLASSIC)),
  ...Object.values(linkedTypePluralLabels(CLASSIC)),
  ...Object.values(objectTypeLabels(CLASSIC)),
  CLASSIC.sections.okrs,
  linkToPlaceholder(CLASSIC.opportunity),
  linkToPlaceholder(CLASSIC.keyResult),
  linkToPlaceholder(CLASSIC.solution),
  linkPlaceholder(CLASSIC.keyResult),
  linkedToLabel(CLASSIC.keyResult),
]

function branchFragments(): Set<string> {
  const produced = new Set<string>(helperOutputs())
  for (const file of CONVERTED_FILES) {
    for (const fragment of copyFragments(readFileSync(path.join(ROOT, file), "utf-8"))) {
      produced.add(substitute(fragment, CLASSIC))
    }
  }
  return produced
}

describe("CLASSIC copy equals origin/main's, string for string", () => {
  it("the baseline was generated from main", () => {
    expect(mainCopy.mainSha).toMatch(/^[0-9a-f]{40}$/)
    expect(Object.keys(mainCopy.files).length).toBeGreaterThan(25)
  })

  it("every entity-bearing fragment main shipped is still produced under CLASSIC", () => {
    const produced = branchFragments()
    const missing = Object.entries(mainCopy.files).flatMap(([file, fragments]) =>
      fragments.filter((f) => !produced.has(f) && !(f in EXCEPTIONS)).map((f) => `${file}: ${JSON.stringify(f)}`),
    )
    expect(missing).toEqual([])
  })

  it("every EXCEPTION is real (no stale entries)", () => {
    const all = new Set(Object.values(mainCopy.files).flat())
    const produced = branchFragments()
    for (const fragment of Object.keys(EXCEPTIONS)) {
      expect(all.has(fragment), `not in main: ${fragment}`).toBe(true)
      expect(produced.has(fragment), `now produced, remove the exception: ${fragment}`).toBe(false)
    }
  })

  it("canary: a changed literal is reported", () => {
    const produced = new Set(["Add objective"])
    expect(["Add objective", "Add Objective"].filter((f) => !produced.has(f))).toEqual(["Add Objective"])
  })
})
