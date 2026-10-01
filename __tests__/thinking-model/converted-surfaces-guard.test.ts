import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { RESERVED_SECTION_NAMES } from "@/lib/thinking-model/validate"
import { CONVERTED_FILES } from "./converted-files"

/**
 * TRIPWIRE, not a proof.
 *
 * The converted surfaces take every entity name from useLabels() / the resolved
 * thinking model. This test scans those files for raw entity words left in string
 * literals, template literal text and JSX text, so a copy edit that reintroduces
 * "Objective" next to a label-driven "Outcome" fails loudly.
 *
 * It is heuristic: it does not parse TypeScript, it cannot see strings built
 * elsewhere, and a determined author can defeat it. A clean run means "no obvious
 * raw entity copy", not "every string is label-driven". The explicit allowlist
 * below is the complete list of raw words that are deliberately left.
 */

const ROOT = process.cwd()

/**
 * Raw words deliberately left, as [file, exact fragment]. "OKR" is the name of
 * the framework, not an entity, and these prefixes keep today's copy
 * ("New OKR Cycle") identical under CLASSIC. Known residue under Torres.
 */
const ALLOWED: Array<[string, string]> = [
  ["components/okrs/create-cycle-form.tsx", "New OKR"],
  ["app/[orgSlug]/[workspaceSlug]/okrs/page.tsx", "No OKR yet"],
  // Markdown template inserted into a new opportunity's description; a heading in
  // user-owned content, not the name of an entity.
  ["components/discovery/opportunity-composer.tsx", "## Who's affected\\n\\n\\n\\n## Current pain\\n\\n\\n\\n## Evidence\\n\\n\\n\\n## Desired outcome\\n\\n"],
]

const normalize = (s: string) => s.replace(/\s+/g, " ").trim()

const ENTITY_WORD =
  /\b(objectives?|key[ -]results?|krs?|okrs?|outcomes?|opportunit(?:y|ies)|solutions?|cycles?|success metrics?)\b/i

export function stripNonCopy(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .replace(/\bfrom\s+["'][^"']*["']/g, "")
    .replace(/^\s*import\s+["'][^"']*["'];?$/gm, "")
}

/** Static text of "..." / '...' / `...` literals, with ${...} expressions removed. */
function stringFragments(source: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source))) {
    const raw = m[1] ?? m[2] ?? m[3] ?? ""
    // Empty, not a space, so a path like `/${org}/${ws}/okrs/` stays one token.
    out.push(raw.replace(/\$\{[^}]*\}/g, ""))
  }
  return out
}

/** Text between tags on a line, after dropping literals and {expressions}. */
function jsxTextFragments(source: string): string[] {
  const out: string[] = []
  for (const line of source.split("\n")) {
    const text = line
      .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, " ")
      .replace(/\{[^{}]*\}/g, " ")
      .replace(/<[^>]*>?/g, "\u0000")
    for (const segment of text.split("\u0000")) {
      const s = segment.trim()
      // Code never looks like prose: no operators, call parens, or statement ends.
      // A parenthesised word ("(optional)") is prose; a call is `name(`.
      const prose = s.replace(/&(?:apos|amp|quot);/g, "").replace(/\s\([A-Za-z ]*\)/g, "")
      if (!s || /[=;()[\]{}<>|&]/.test(prose)) continue
      if (!/^[A-Za-z]/.test(s)) continue
      // Object-literal lines (`cycleId: x.id,`) and property access (`kr.id`).
      if (/^[\w$]+\s*:/.test(s) || /\w\.\w/.test(s)) continue
      out.push(s)
    }
  }
  return out
}

export function rawEntityCopy(source: string): string[] {
  const cleaned = stripNonCopy(source)
  const hits: string[] = []
  // Strings that are copy by position, so even a lone lowercase token counts:
  // label="objective", placeholder="…", `label: "…"`, aria-label, title, alt.
  const copyPositions =
    /\b(?:label|aria-label|placeholder|title|alt|emptyMessage|inputPlaceholder|description|templateLabel)\s*[=:]\s*\{?\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)')/g
  const positional = new Set<string>()
  for (const m of cleaned.matchAll(copyPositions)) {
    const text = m[1] ?? m[2] ?? ""
    if (ENTITY_WORD.test(text)) {
      positional.add(text)
      hits.push(text)
    }
  }
  for (const fragment of stringFragments(cleaned)) {
    const f = fragment.trim()
    if (!ENTITY_WORD.test(f)) continue
    if (positional.has(fragment)) continue
    const singleToken = !/\s/.test(f)
    // Identifiers and paths: "objective", "OBJECTIVE", "keyResult", "/okrs/".
    if (singleToken && !/^[A-Z][a-z]+s?$/.test(f)) continue
    hits.push(fragment)
  }
  for (const s of jsxTextFragments(cleaned)) {
    if (!ENTITY_WORD.test(s)) continue
    const words = s.split(/\s+/)
    if (words.length < 2 && !/^[A-Z]/.test(s)) continue
    hits.push(s)
  }
  return hits
}

describe("converted surfaces carry no raw entity copy (tripwire)", () => {
  it.each(CONVERTED_FILES)("%s", (file) => {
    const source = readFileSync(path.join(ROOT, file), "utf-8")
    const allowed = ALLOWED.filter(([f]) => f === file).map(([, fragment]) => fragment)
    const offenders = rawEntityCopy(source).filter((fragment) => !allowed.includes(normalize(fragment)))
    expect(offenders).toEqual([])
  })

  it("every ALLOWED entry is still produced by its file (no stale allowlist)", () => {
    for (const [file, fragment] of ALLOWED) {
      const hits = rawEntityCopy(readFileSync(path.join(ROOT, file), "utf-8")).map(normalize)
      expect(hits, `${file}: stale allowlist entry ${JSON.stringify(fragment)}`).toContain(fragment)
      expect(CONVERTED_FILES).toContain(file)
    }
  })

  it("RESERVED_SECTION_NAMES covers every static label in the sidebar and bottom nav", () => {
    const labels = ["components/sidebar.tsx", "components/bottom-nav.tsx"].flatMap((file) =>
      [...readFileSync(path.join(ROOT, file), "utf-8").matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]),
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
})
