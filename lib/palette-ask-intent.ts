// Decides whether the Cmd+K palette should lead with "Ask AI" or with search
// results. Pure so the heuristic can be unit-tested without rendering.

const ASK_VERBS = new Set([
  "summarise", "summarize", "create", "draft", "find", "compare", "list", "explain",
  "why", "how", "what", "who", "when", "which", "write", "make", "log", "add",
  "show", "tell", "suggest", "rewrite",
])

/** Queries with at least this many words read as a request, not a lookup. */
export const ASK_MIN_WORDS = 5

/** Longest text taken from the page selection as palette context. */
export const MAX_SELECTION_CHARS = 2000

export type PaletteMode = "search" | "ask"

export function looksLikeQuestion(query: string): boolean {
  const trimmed = query.trim()
  if (!trimmed) return false
  if (trimmed.endsWith("?")) return true
  const words = trimmed.split(/\s+/)
  if (words.length >= ASK_MIN_WORDS) return true
  return ASK_VERBS.has(words[0].toLowerCase().replace(/[^a-z]/g, ""))
}

export function paletteMode(input: { query: string; forceAsk?: boolean; forceSearch?: boolean; hasSelection?: boolean }): PaletteMode {
  if (input.forceAsk) return "ask"
  // e.g. "Find similar" prefills a long query that must still be a lookup.
  if (input.forceSearch) return "search"
  const trimmed = input.query.trim()
  // A selection with nothing typed yet is a request to ask about it.
  if (!trimmed) return input.hasSelection ? "ask" : "search"
  return looksLikeQuestion(trimmed) ? "ask" : "search"
}

/** Trimmed, length-capped selection text, or "" when there is nothing usable. */
export function normalizeSelection(raw: string): string {
  const text = raw.trim()
  return text.length > MAX_SELECTION_CHARS ? `${text.slice(0, MAX_SELECTION_CHARS)}…` : text
}

/** Composer text for the agent: the question, with any selection quoted beneath it. */
export function buildAskText(query: string, selection: string): string {
  const question = query.trim()
  if (!selection) return question
  const quoted = selection.split("\n").map((line) => `> ${line}`).join("\n")
  return question ? `${question}\n\n${quoted}` : `About this selection:\n\n${quoted}`
}
