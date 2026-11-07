import { parseEntityLink, type ParsedEntityLink, type WorkspaceSlugs } from "@/lib/entity-links"
import { splitWorkItemRefs } from "@/lib/work-item-linkify"

/** One thing the assistant pointed at in the thread: a Compass entity or an outside link. */
export type Mention =
  | { kind: "entity"; key: string; href: string; link: ParsedEntityLink }
  | { kind: "external"; key: string; href: string; host: string }

const MARKDOWN_LINK_RE = /\]\(\s*<?([^)\s>]+)>?[^)]*\)/g
const BARE_URL_RE = /https?:\/\/[^\s)<>\]"']+/g

function trimTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:!?]+$/, "")
}

/**
 * Links the assistant wrote in its replies (including bare display IDs when a scope is given), newest first, one per target, capped at limit.
 * Pure: entity links are recognised with parseEntityLink (so page links and other hosts never become entity pills),
 * and anything else with an http(s) URL becomes an external pill. Whether the reader may see an entity is decided
 * later, when its pill asks for the summary.
 */
export function extractMentions(
  messages: ReadonlyArray<{ role: string; content: string }>,
  origin: string | null,
  limit = 8,
  scope: WorkspaceSlugs | null = null,
): Mention[] {
  const out: Mention[] = []
  const seen: Set<string> = new Set()

  const add = (rawHref: string) => {
    const href = trimTrailingPunctuation(rawHref)
    const link = parseEntityLink(href, origin)
    if (link) {
      const key = `${link.orgSlug}/${link.workspaceSlug}/${link.type}/${link.id.toLowerCase()}`
      if (seen.has(key)) return
      seen.add(key)
      out.push({ kind: "entity", key, href, link })
      return
    }
    if (!/^https?:\/\//i.test(href)) return
    let url: URL
    try {
      url = new URL(href)
    } catch {
      return
    }
    if (origin && url.origin === origin) return // a Compass page that is not an entity
    const key = `ext:${url.host}${url.pathname}${url.search}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ kind: "external", key, href, host: url.host.replace(/^www\./, "") })
  }

  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const m = messages[i]
    if (m.role !== "assistant" || !m.content) continue
    const hits: Array<{ index: number; href: string }> = []
    for (const match of m.content.matchAll(MARKDOWN_LINK_RE)) hits.push({ index: match.index ?? 0, href: match[1] })
    // Bare URLs that are not already the target of a markdown link.
    const inLinks = new Set(hits.map((h) => h.href))
    for (const match of m.content.matchAll(BARE_URL_RE)) {
      if (!inLinks.has(trimTrailingPunctuation(match[0]))) hits.push({ index: match.index ?? 0, href: match[0] })
    }
    // Display IDs in prose (TASK-12) only become links at render time, so they are not in the text above. Mirror
    // that step, using the same splitter the renderer uses, so a card in the transcript is also a pill.
    const parts = scope ? splitWorkItemRefs(m.content, scope) : null
    if (parts) {
      let offset = 0
      for (const part of parts) {
        if (part.type === "link") hits.push({ index: offset, href: part.url })
        offset += part.type === "link" ? part.children[0].value.length : part.value.length
      }
    }
    // Later in a message is more recent.
    hits.sort((a, b) => b.index - a.index)
    for (const hit of hits) add(hit.href)
  }
  return out.slice(0, limit)
}
