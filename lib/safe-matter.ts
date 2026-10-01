/**
 * The ONLY module in this repository allowed to import `gray-matter`.
 *
 * gray-matter's default `javascript`/`js` front-matter engine calls `eval()` on
 * any block opened with `---js` or `---javascript`. Front matter reaches us from
 * untrusted sources (MCP create_doc/update_doc content, skill markdown fetched
 * from GitHub), so that is remote code execution inside the function serving
 * every tenant (security finding 751ba517e8e08d8c).
 *
 * `safeMatter` is a drop-in for `matter(input)` that
 *   1. rejects any front-matter language other than yaml (or none) before
 *      gray-matter looks at it, and
 *   2. replaces the js/javascript engines with ones that throw, so no code path
 *      inside gray-matter can reach eval().
 *
 * `__tests__/safe-matter.test.ts` fails if any other file imports gray-matter.
 */
import matter from "gray-matter"

export type SafeMatterResult = ReturnType<typeof matter>

const ALLOWED_LANGUAGES = new Set(["", "yaml", "yml"])

function refuse(language: string): never {
  throw new Error(`Unsupported front matter language "${language}": only YAML front matter is allowed`)
}

const ENGINES = {
  js: { parse: () => refuse("js") },
  javascript: { parse: () => refuse("javascript") },
}

/** The language tag on the opening `---` line, exactly as gray-matter would read it. */
function frontMatterLanguage(raw: string): string {
  const str = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  if (!str.startsWith("---") || str.charAt(3) === "-") return ""
  const eol = str.search(/\r?\n/)
  return (eol === -1 ? str.slice(3) : str.slice(3, eol)).trim().toLowerCase()
}

export function safeMatter(input: string): SafeMatterResult {
  const language = frontMatterLanguage(input)
  if (!ALLOWED_LANGUAGES.has(language)) refuse(language)
  // Passing options also bypasses gray-matter's global string cache.
  return matter(input, { engines: ENGINES })
}

/** YAML-only serializer (never selects a js engine); keeps the gray-matter import in this module. */
export function stringifyFrontMatter(body: string, data: Record<string, unknown>): string {
  return matter.stringify(body, data, { engines: ENGINES })
}
