import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { CONVERTED_FILES } from "./converted-files"
import { copyFragments, labelAccesses, substitute } from "./copy-extract"
import { resolveThinkingModel } from "@/lib/thinking-model/resolve"
import { indefiniteTitle, linkPlaceholder, linkToPlaceholder, linkedToLabel } from "@/lib/thinking-model/copy"
import { NO_CYCLE_LABEL, noCycleLabel } from "@/lib/okr-cycle-scope"
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
  // #332 (optional Objective cycle) deliberately reworded this CLASSIC text; main's baseline predates it. The new text is
  // pinned verbatim below ("#332 optional-cycle copy"). When #332 reaches main and the baselines are regenerated, this
  // entry goes stale and the "every EXCEPTION is real" test says to delete it.
  "No eligible parent KRs. A longer cycle must be Draft or Active and fully contain this cycle's dates.":
    "reworded by #332; the shipped text is pinned in '#332 optional-cycle copy'",
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

/**
 * Files that are label-helper modules: their main-side literals ("Objective", "Roadmap Item") now come out of a function
 * (panelTitles(labels), linkedTypeLabels(labels), ...), so for these only, the helper outputs count as produced.
 * Every other file is compared on its OWN fragments: a string that moved out of a component must still be produced by
 * that component, not merely by some other file or by a label form that happens to equal it.
 */
const HELPER_FILES = new Set([
  "components/panels/panel-titles.ts",
  "components/tasks/linked-type-labels.ts",
  "components/custom-fields/object-type-labels.ts",
  "lib/canvas/tiers.ts",
])

/** A file that builds phrases through the copy helpers (articles, titles, tiers) produces multi-word text with them. */
const USES_COPY_HELPER = /linkToPlaceholder|linkPlaceholder|linkedToLabel|indefiniteTitle|panelTitles|linkedTypeLabels|linkedTypePluralLabels|objectTypeLabels|noCycleLabel|tierLabels|trackedSubjectLabels|ostLegendRootLabel/

/** Helpers that return a whole name map (panel titles, linked-type names, custom-field object types). */
const USES_NAME_MAP_HELPER = /panelTitles|linkedTypeLabels|linkedTypePluralLabels|objectTypeLabels/

/**
 * Fragments a specific file no longer produces as text, with the reason and what pins it instead. Per file, so one file's
 * exception cannot hide another file's regression.
 */
const FILE_EXCEPTIONS: Record<string, Record<string, string>> = {
  "components/panels/objective-panel.tsx": { "/{}/{}/okrs": "a route, not copy: #332 appends cycleRouteSegment(cycle?.id)" },
  "components/discovery/opportunity-field-board.tsx": { solution: "now plural(count, labels.solution); pinned by 'opportunity-field-board' in classic-text.test.tsx" },
  "components/discovery/discovery-group-by-toggle.tsx": {
    Opportunity: "the Group-by Opportunity swimlane option moved to the /solutions backlog",
    opportunity: "the Group-by Opportunity swimlane option moved to the /solutions backlog",
  },
  "components/discovery/ost-tree-view.tsx": { Outcome: "the legend root word comes from ostLegendRootLabel(); pinned by 'ost-tree linked' in classic-text.test.tsx and the helper test" },
}

/**
 * This file's own fragments with each `labels.x.y` expression replaced by its CLASSIC value, plus every label the file
 * reads directly (a label passed as a prop is how it produces that word). Helper outputs count only for helper modules,
 * and for multi-word phrases in a file that calls a copy helper. WEAKER than the render harness
 * (classic-text.test.tsx): a file that reads a label somewhere satisfies a bare one-word fragment of that label.
 */
function fileFragments(file: string): Set<string> {
  const source = readFileSync(path.join(ROOT, file), "utf-8")
  const produced = new Set<string>()
  for (const fragment of copyFragments(source, file)) produced.add(substitute(fragment, CLASSIC))
  for (const token of labelAccesses(source, file)) produced.add(substitute(token, CLASSIC))
  if (HELPER_FILES.has(file)) for (const output of helperOutputs()) produced.add(output)
  else if (USES_NAME_MAP_HELPER.test(source)) for (const output of helperOutputs()) produced.add(output)
  else if (USES_COPY_HELPER.test(source)) for (const output of helperOutputs()) if (/\s/.test(output)) produced.add(output)
  return produced
}

/** All fragments the branch produces anywhere (used only to prove an EXCEPTION is really gone). */
function branchFragments(): Set<string> {
  const produced = new Set<string>(helperOutputs())
  for (const file of CONVERTED_FILES) for (const f of fileFragments(file)) produced.add(f)
  return produced
}

describe("CLASSIC copy equals origin/main's, string for string", () => {
  it("the baseline was generated from main", () => {
    expect(mainCopy.mainSha).toMatch(/^[0-9a-f]{40}$/)
    expect(Object.keys(mainCopy.files).length).toBeGreaterThan(25)
  })

  it("every entity-bearing fragment main shipped is still produced under CLASSIC, by the same file", () => {
    const missing = Object.entries(mainCopy.files).flatMap(([file, fragments]) => {
      const produced = fileFragments(file)
      const fileExceptions = FILE_EXCEPTIONS[file] ?? {}
      return fragments.filter((f) => !produced.has(f) && !(f in EXCEPTIONS) && !(f in fileExceptions)).map((f) => `${file}: ${JSON.stringify(f)}`)
    })
    expect(missing).toEqual([])
  })

  it("every FILE_EXCEPTION is real (in main's file, and no longer produced by it)", () => {
    for (const [file, entries] of Object.entries(FILE_EXCEPTIONS)) {
      const produced = fileFragments(file)
      for (const fragment of Object.keys(entries)) {
        expect(mainCopy.files[file] ?? [], `${file}: not in main: ${fragment}`).toContain(fragment)
        expect(produced.has(fragment), `${file}: now produced, remove the exception: ${fragment}`).toBe(false)
      }
    }
  })

  it("canary: a fragment that only another file or a bare label form produces does not count", () => {
    // "Solution" is a label form, and other files say it; a file that lost its own "Solution" must still fail.
    expect(fileFragments("components/okrs/cycle-card.tsx").has("Solution")).toBe(false)
    expect(branchFragments().has("Solution")).toBe(true)
  })

  it("every EXCEPTION is real (no stale entries)", () => {
    const all = new Set(Object.values(mainCopy.files).flat())
    const produced = branchFragments()
    for (const fragment of Object.keys(EXCEPTIONS)) {
      expect(all.has(fragment), `not in main: ${fragment}`).toBe(true)
      expect(produced.has(fragment), `now produced, remove the exception: ${fragment}`).toBe(false)
    }
  })

  // The text #332 shipped, character for character. CLASSIC must still read exactly like this after the label conversion.
  describe("#332 optional-cycle copy", () => {
    it("the pseudo-cycle name", () => {
      expect(noCycleLabel(CLASSIC.cycle)).toBe("No cycle / Persistent")
      expect(NO_CYCLE_LABEL).toBe("No cycle / Persistent")
    })

    it("the OKRs index link", () => {
      expect(`Or add ${indefiniteTitle(CLASSIC.objective)} with no ${CLASSIC.cycle.lower} (${noCycleLabel(CLASSIC.cycle)})`).toBe(
        "Or add an Objective with no cycle (No cycle / Persistent)",
      )
    })

    it("the persistent page description and the parent-KR picker message are still produced", () => {
      const produced = branchFragments()
      expect(produced.has("No eligible parent KRs. A cycle-less Objective can support any Key Result in a Draft or Active cycle; otherwise the parent cycle must be Draft or Active, longer, and fully contain this cycle's dates.")).toBe(true)
      expect(`${CLASSIC.objective.plural} that are not tied to a planning period. They can support, and be supported by, ${CLASSIC.keyResult.plural} in any open ${CLASSIC.cycle.lower}.`).toBe(
        "Objectives that are not tied to a planning period. They can support, and be supported by, Key Results in any open cycle.",
      )
    })
  })

  it("canary: a changed literal is reported", () => {
    const produced = new Set(["Add objective"])
    expect(["Add objective", "Add Objective"].filter((f) => !produced.has(f))).toEqual(["Add Objective"])
  })
})
