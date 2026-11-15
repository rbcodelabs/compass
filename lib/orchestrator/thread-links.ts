/**
 * Parsing, markdown rewriting, and DOM card-highlight helpers for orchestrator
 * `[[thread:<id>|Title]]` references (Phase 6 / PR 6).
 */

const THREAD_WIKILINK_PATTERN = /\[\[thread:([^\]|\n]+?)(?:\\?\|([^\]\n]+))?\]\]/g
const THREAD_HREF_HASH = "#thread-link"

export type ParsedThreadLink = {
  threadId: string
  label: string
}

function sanitizeLinkLabel(raw: string): string {
  return raw.replace(/[\[\]\\]+/g, " ").replace(/\s+/g, " ").trim()
}

/**
 * Rewrites `[[thread:<id>|Title]]` (and `[[thread:<id>]]`) markers into standard
 * Markdown links (`[Title](?c=<id>#thread-link)`) so `ReactMarkdown` renders them
 * inside paragraphs, lists, and GFM tables without splitting surrounding syntax.
 */
export function rewriteThreadWikilinks(markdown: string | null | undefined): string {
  if (!markdown) return ""
  return markdown.replace(THREAD_WIKILINK_PATTERN, (_match, rawId: string, rawLabel?: string) => {
    const id = rawId.trim()
    if (!id) return rawLabel?.trim() || ""
    const fallbackLabel = id.length > 12 ? `Thread ${id.slice(0, 8)}` : `Thread ${id}`
    const label = sanitizeLinkLabel(rawLabel?.trim() || fallbackLabel) || fallbackLabel
    return `[${label}](?c=${encodeURIComponent(id)}${THREAD_HREF_HASH})`
  })
}

/** Extracts `threadId` from a rewritten `?c=<id>#thread-link` href, or returns null. */
export function parseThreadLinkHref(href: string | undefined): string | null {
  if (!href) return null
  if (!href.endsWith(THREAD_HREF_HASH)) return null
  const withoutHash = href.slice(0, -THREAD_HREF_HASH.length)
  const queryStart = withoutHash.indexOf("?")
  if (queryStart === -1) return null
  const params = new URLSearchParams(withoutHash.slice(queryStart + 1))
  const c = params.get("c")?.trim()
  return c || null
}

/**
 * Scrolls `[data-board-card="<threadId>"]` into view and applies a highlighted ring
 * while hovering or focusing a `[[thread:<id>|Title]]` chip.
 */
export function highlightBoardCard(
  threadId: string,
  options: { scroll?: boolean } = { scroll: true },
): boolean {
  if (typeof document === "undefined") return false
  clearBoardCardHighlights()
  const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(threadId) : threadId.replace(/"/g, '\\"')
  const el = document.querySelector<HTMLElement>(`[data-board-card="${escaped}"]`)
  if (!el) return false
  el.setAttribute("data-highlighted", "true")
  el.classList.add("ring-2", "ring-status-info", "border-border-focus")
  if (options.scroll !== false && typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" })
  }
  return true
}

/** Removes any active `[data-board-card]` hover/focus highlight on the board. */
export function clearBoardCardHighlights(): void {
  if (typeof document === "undefined") return
  const highlighted = document.querySelectorAll<HTMLElement>('[data-board-card][data-highlighted="true"]')
  for (const el of highlighted) {
    el.removeAttribute("data-highlighted")
    el.classList.remove("ring-2", "ring-status-info", "border-border-focus")
  }
}
