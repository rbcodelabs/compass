/**
 * Pulls user-visible copy fragments out of a component's SOURCE TEXT, so the same
 * extractor can read origin/main's files (literals) and this branch's files
 * (literals plus `labels.x.y` expressions). Plain text scanning, no TypeScript
 * parser: it is a comparison aid, not a proof. Self-contained (no imports) so
 * scripts/regenerate-thinking-model-baselines.ts can load it directly under Node.
 */

export const ENTITY_WORD =
  /\b(objectives?|key[ -]results?|krs?|okrs?|outcomes?|opportunit(?:y|ies)|solutions?|cycles?|success metrics?)\b/i

type LabelValues = Record<string, Record<string, string>>

const OPEN = "⟦"
const CLOSE = "⟧"

export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .replace(/\bfrom\s+["'][^"']*["']/g, "")
}

/** `${labels.cycle.lowerPlural}` / `{labels.cycle.lowerPlural}` => token; any other expression => `{}`. */
function exprToken(expr: string): string {
  const m = expr.trim().match(/(?:^|[.\s(])labels\.(\w+)\.(\w+)\s*$/)
  return m ? `${OPEN}${m[1]}.${m[2]}${CLOSE}` : "{}"
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim()

/** Every string/template literal and JSX text segment, with expressions tokenised. */
export function copyFragments(source: string): string[] {
  const code = stripComments(source)
  const out: string[] = []

  const literal = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g
  for (const m of code.matchAll(literal)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? ""
    const text = m[3] !== undefined ? raw.replace(/\$\{([^}]*)\}/g, (_, e: string) => exprToken(e)) : raw
    if (norm(text)) out.push(norm(text))
  }

  for (const line of code.split("\n")) {
    const text = line
      .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, " ")
      .replace(/\{([^{}]*)\}/g, (_, e: string) => exprToken(e))
      .replace(/<[^>]*>?/g, "\u0000")
    for (const segment of text.split("\u0000")) {
      const s = norm(segment)
      if (!s || !/^[A-Za-z⟦]/.test(s)) continue
      // Judge "is this code?" on the text with tokens collapsed, since a token
      // ("keyResult.singular") itself looks like property access.
      const plain = s.replace(new RegExp(`${OPEN}[^${CLOSE}]*${CLOSE}`, "g"), "T")
      if (/[=;[\]|]/.test(plain.replace(/&(?:apos|amp|quot);/g, ""))) continue
      if (/^[\w$]+\s*:/.test(plain) || /\w\.\w/.test(plain)) continue
      out.push(s)
    }
  }
  return out
}

/** Replace label tokens with concrete values (CLASSIC, in the tests). */
export function substitute(fragment: string, labels: LabelValues): string {
  return norm(
    fragment.replace(new RegExp(`${OPEN}(\\w+)\\.(\\w+)${CLOSE}`, "g"), (_, a: string, b: string) => labels[a]?.[b] ?? `${OPEN}${a}.${b}${CLOSE}`),
  )
}

/** The entity-bearing fragments of a main-branch file: what must still be producible under CLASSIC. */
export function entityFragments(source: string): string[] {
  return [...new Set(copyFragments(source).filter((f) => ENTITY_WORD.test(f)))]
}
