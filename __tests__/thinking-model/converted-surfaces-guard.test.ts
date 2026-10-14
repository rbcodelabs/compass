import { describe, expect, it } from "vitest"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { RESERVED_SECTION_NAMES } from "@/lib/thinking-model/validate"
import { OVERRIDABLE_ENTITIES, THINKING_MODEL_ENTITIES, type ThinkingModelEntity } from "@/lib/thinking-model/presets"
import { REMAINING_CANONICAL_SURFACES } from "@/lib/thinking-model/canonical-surfaces"
import { CANONICAL_FILES, CANONICAL_PREFIXES, CONVERTED_FILES, ENTITY_SCREENS } from "./converted-files"
import { rawEntityCopy } from "./copy-extract"

/**
 * TRIPWIRE, not a proof.
 *
 * The converted surfaces take every entity name from useLabels() / the resolved
 * thinking model. This test scans those files for raw entity words left in string
 * literals, template literal text and JSX text, so a copy edit that reintroduces
 * "Objective" next to a label-driven "Outcome" fails loudly.
 *
 * It parses the source (copy-extract.ts) but it is still heuristic: it cannot see
 * strings built elsewhere or imported, and a determined author can defeat it. A clean
 * run means "no obvious raw entity copy", not "every string is label-driven". The
 * explicit allowlist below is the complete list of raw words that are deliberately left.
 *
 * Three further checks hang off the same scan (Phase 4C-2):
 *  - an entity may only be overridable if every known screen that names it is converted;
 *  - every component or app file with raw entity copy is either converted or listed as
 *    canonical, with the reason category the settings notice and the help page use;
 *  - the canonical list itself is consistent with the source tree (no stale entries).
 */

const ROOT = process.cwd()

/**
 * Raw words deliberately left, as [file, exact fragment]. "OKR" is the name of
 * the framework, not an entity, and these prefixes keep today's copy
 * ("New OKR Cycle") identical under CLASSIC. Known residue under Torres.
 */
const ALLOWED: Array<[string, string]> = [
  ["components/okrs/create-cycle-form.tsx", "New OKR"],
  // Page title "OKR <Cycle>": "OKR" is the framework word, like the form's "New OKR".
  ["app/[orgSlug]/[workspaceSlug]/okrs/[cycleId]/page.tsx", "OKR"],
  ["app/[orgSlug]/[workspaceSlug]/okrs/page.tsx", "No OKR yet"],
  // Markdown template inserted into a new opportunity's description; a heading in
  // user-owned content, not the name of an entity.
  ["components/discovery/opportunity-composer.tsx", "## Who's affected ## Current pain ## Evidence ## Desired outcome"],
  // "Outcome" here is the decision's outcome (Approved / Changes requested / Rejected), not an Objective.
  ["components/decisions/decisions-filters.tsx", "Outcome"],
  // The ordinary English word, in a placeholder.
  ["components/feedback/feedback-composer.tsx", "What problem does this solve? Who runs into it, and what would a great outcome look like?"],
]

const normalize = (s: string) => s.replace(/\s+/g, " ").trim()

/** Which words name which entity, for the per-entity coverage check. */
const ENTITY_WORDS: Record<ThinkingModelEntity, RegExp> = {
  opportunity: /\bopportunit(?:y|ies)\b/i,
  objective: /\b(?:objectives?|outcomes?)\b/i,
  keyResult: /\b(?:key[ -]results?|krs?|success metrics?)\b/i,
  solution: /\bsolutions?\b/i,
  cycle: /\bcycles?\b/i,
}

const read = (file: string) => readFileSync(path.join(ROOT, file), "utf-8")
const allowedFor = (file: string) => ALLOWED.filter(([f]) => f === file).map(([, fragment]) => fragment)
const offendersIn = (file: string) => rawEntityCopy(read(file), file).filter((fragment) => !allowedFor(file).includes(normalize(fragment)))

/**
 * For the given entities, the screens that name them but are not converted, or still carry that entity's raw words.
 * Pure over its inputs so the canary can feed it a deliberately broken world.
 */
export function unconvertedScreens(
  overridable: readonly ThinkingModelEntity[],
  screens: Record<string, readonly string[]>,
  converted: readonly string[],
  scan: (file: string) => string[],
): string[] {
  const problems: string[] = []
  for (const entity of overridable) {
    const files = screens[entity] ?? []
    if (files.length === 0) problems.push(`${entity}: overridable but no known screens are recorded for it`)
    for (const file of files) {
      if (!converted.includes(file)) problems.push(`${entity}: ${file} is not in CONVERTED_FILES`)
      for (const hit of scan(file)) if (ENTITY_WORDS[entity].test(hit)) problems.push(`${entity}: ${file} still says ${JSON.stringify(hit)}`)
    }
  }
  return problems
}

function walk(dir: string): string[] {
  const full = path.join(ROOT, dir)
  if (!existsSync(full)) return []
  return readdirSync(full).flatMap((entry) => {
    if (entry === "node_modules" || entry.startsWith(".")) return []
    const rel = `${dir}/${entry}`
    return statSync(path.join(ROOT, rel)).isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\.|\.d\.ts$/.test(entry) ? [rel] : []
  })
}

const canonicalCategoryOf = (file: string): string | undefined =>
  CANONICAL_FILES[file] ?? CANONICAL_PREFIXES.find(([prefix]) => file.startsWith(prefix))?.[1]

describe("converted surfaces carry no raw entity copy (tripwire)", () => {
  it.each(CONVERTED_FILES)("%s", (file) => {
    expect(offendersIn(file)).toEqual([])
  })

  it("every ALLOWED entry is still produced by its file (no stale allowlist)", () => {
    for (const [file, fragment] of ALLOWED) {
      const hits = rawEntityCopy(read(file), file).map(normalize)
      expect(hits, `${file}: stale allowlist entry ${JSON.stringify(fragment)}`).toContain(fragment)
      expect(CONVERTED_FILES).toContain(file)
    }
  })

  it("every converted file exists", () => {
    for (const file of CONVERTED_FILES) expect(existsSync(path.join(ROOT, file)), file).toBe(true)
  })

  it("RESERVED_SECTION_NAMES covers every static label in the sidebar and bottom nav", () => {
    const labels = ["components/sidebar.tsx", "components/bottom-nav.tsx"].flatMap((file) =>
      [...read(file).matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]),
    )
    expect(labels.length).toBeGreaterThan(8)
    const reserved = RESERVED_SECTION_NAMES.map((n) => n.toLowerCase())
    // "OKRs" is built from the model at runtime (labels.sections.okrs), so it is reserved but not static.
    expect(labels.filter((label) => !reserved.includes(label.toLowerCase()))).toEqual([])
    expect(reserved).toContain("okrs")
  })

  it("canary: flags known-bad fixtures and ignores label-driven copy", () => {
    expect(rawEntityCopy('const x = "Add objective"')).toEqual(["Add objective"])
    expect(rawEntityCopy("<p>\n  Add key result\n</p>")).toEqual(["Add key result"])
    expect(rawEntityCopy("<Label>Key Result (optional)</Label>")).toEqual(["Key Result (optional)"])
    expect(rawEntityCopy("const t = `No ${labels.objective.lowerPlural} yet`")).toEqual([])
    expect(rawEntityCopy('openPanel("objective", id)')).toEqual([])
    expect(rawEntityCopy('type: "OBJECTIVE"')).toEqual([])
    expect(rawEntityCopy("// Add objective in a comment")).toEqual([])
    expect(rawEntityCopy("<p>Add {labels.objective.lower}</p>")).toEqual([])
    // A lone lowercase token in a copy position is copy, not an identifier.
    expect(rawEntityCopy('<PanelError label="objective" />')).toEqual(["objective"])
    expect(rawEntityCopy('<X aria-label="Linked to a key result" />')).toEqual(["Linked to a key result"])
    expect(rawEntityCopy('const items = [{ label: "solution" }]')).toEqual(["solution"])
  })

  it("canary: flags the evasions the first tripwire let through (card-sort-kanban's Badge)", () => {
    // (a) a lone lowercase word between tags
    expect(rawEntityCopy("const a = <Badge>{n} solutions</Badge>")).toEqual(["solutions"])
    expect(rawEntityCopy("const a = <b>solution</b>")).toEqual(["solution"])
    // (b) a template whose only static text is a trailing word
    expect(rawEntityCopy("const t = `${n} solutions`")).toEqual(["solutions"])
    // (c) lone lowercase literals inside a JSX expression, a count-based plural pick, or a concatenation
    expect(rawEntityCopy('const a = <Badge>{n === 1 ? "solution" : "solutions"}</Badge>')).toEqual(["solution", "solutions"])
    expect(rawEntityCopy('const label = n === 1 ? "solution" : "solutions"')).toEqual(["solution", "solutions"])
    expect(rawEntityCopy('const t = "Add " + "opportunity"')).toEqual(["opportunity"])
    expect(rawEntityCopy('const a = <p>{ready ? "opportunity" : null}</p>')).toEqual(["opportunity"])
    // the real file shape, before conversion
    expect(rawEntityCopy('function C(){ return <Badge variant="secondary">{meta.solutionCount} {meta.solutionCount === 1 ? "solution" : "solutions"}</Badge> }')).toEqual(["solution", "solutions"])
  })

  it("canary: identifier contexts stay allowed", () => {
    expect(rawEntityCopy('openPanel("solution", id)')).toEqual([])
    expect(rawEntityCopy('const a = kind === "solution" ? x : y')).toEqual([])
    expect(rawEntityCopy('const o = { type: cond ? "opportunity" : "solution" }')).toEqual([])
    expect(rawEntityCopy('const a = <X value="solution" data-slot="opportunity-board" />')).toEqual([])
    expect(rawEntityCopy('const m = { solution: 1 }; m["solution"]')).toEqual([])
    expect(rawEntityCopy('if (set.has("solution")) go()')).toEqual([])
    expect(rawEntityCopy("const a = <p>{labels.solution.lowerPlural}</p>")).toEqual([])
    expect(rawEntityCopy('const a = <p>{n === 1 ? labels.solution.lower : labels.solution.lowerPlural}</p>')).toEqual([])
  })

  it("canary: sees copy the old line scanner missed (one-line conditionals, ids stay ignored)", () => {
    expect(rawEntityCopy("const a = <div>{!compact && <p className=\"x\">Not a key result update.</p>}</div>")).toEqual(["Not a key result update."])
    expect(rawEntityCopy("const a = cond ? <b>Open the new opportunity</b> : null")).toEqual(["Open the new opportunity"])
    expect(rawEntityCopy("const id = `outcome-kr-chip-${a}-${b}`")).toEqual([])
    expect(rawEntityCopy("const p = `/${org}/${ws}/okrs/${id}`")).toEqual([])
    expect(rawEntityCopy('const el = <div data-testid="opportunity-board" />')).toEqual([])
  })
})

describe("an entity may only be overridable once its screens are converted", () => {
  it("ENTITY_SCREENS records screens for every entity", () => {
    expect(Object.keys(ENTITY_SCREENS).sort()).toEqual([...THINKING_MODEL_ENTITIES].sort())
  })

  it("every overridable entity: all its known screens are converted and carry none of its raw words", () => {
    const problems = unconvertedScreens(OVERRIDABLE_ENTITIES, ENTITY_SCREENS, CONVERTED_FILES, (file) => rawEntityCopy(read(file), file).filter((f) => !allowedFor(file).includes(normalize(f))))
    expect(problems).toEqual([])
  })

  it("canary: the check fails for an overridable entity with an unconverted or raw screen, or none recorded", () => {
    const fake = { opportunity: ["a.tsx", "b.tsx"], cycle: [] }
    const scan = (file: string) => (file === "b.tsx" ? ["Add a new opportunity"] : [])
    const problems = unconvertedScreens(["opportunity", "cycle"], fake, ["b.tsx"], scan)
    expect(problems).toEqual([
      "opportunity: a.tsx is not in CONVERTED_FILES",
      'opportunity: b.tsx still says "Add a new opportunity"',
      "cycle: overridable but no known screens are recorded for it",
    ])
    // A word that belongs to another entity is not this entity's problem.
    expect(unconvertedScreens(["cycle"], { cycle: ["c.tsx"] }, ["c.tsx"], () => ["Add an objective"])).toEqual([])
  })
})

describe("every component and app file with raw entity copy is converted or listed as canonical", () => {
  const files = [...walk("components"), ...walk("app")]

  it("scans a real tree", () => {
    expect(files.length).toBeGreaterThan(300)
  })

  it("no file is silently left unconverted", () => {
    const converted = new Set<string>(CONVERTED_FILES)
    const stray = files.filter((file) => !converted.has(file) && !canonicalCategoryOf(file) && rawEntityCopy(read(file), file).length > 0)
    expect(stray, "convert these screens (add them to CONVERTED_FILES) or list them in CANONICAL_FILES with a reason").toEqual([])
  })

  it("canonical files and prefixes name a real category, exist, and really carry raw copy (no stale entries)", () => {
    const ids = new Set(REMAINING_CANONICAL_SURFACES.map((s) => s.id))
    for (const [file, category] of Object.entries(CANONICAL_FILES)) {
      expect(ids.has(category), `${file}: unknown category ${category}`).toBe(true)
      expect(existsSync(path.join(ROOT, file)), `${file} does not exist`).toBe(true)
      expect(rawEntityCopy(read(file), file).length, `${file} has no raw entity copy: convert-and-remove or drop the entry`).toBeGreaterThan(0)
      expect(CONVERTED_FILES as readonly string[], `${file} is both converted and canonical`).not.toContain(file)
    }
    for (const [prefix, category] of CANONICAL_PREFIXES) {
      expect(ids.has(category), `${prefix}: unknown category ${category}`).toBe(true)
      expect(files.some((file) => file.startsWith(prefix)), `${prefix} matches no file`).toBe(true)
    }
  })

  it("every category in the settings notice and help page is backed by the source tree", () => {
    const used = new Set([...Object.values(CANONICAL_FILES), ...CANONICAL_PREFIXES.map(([, category]) => category)])
    expect(REMAINING_CANONICAL_SURFACES.map((s) => s.id).filter((id) => !used.has(id))).toEqual([])
  })
})
