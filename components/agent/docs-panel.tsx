"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { KeyboardEvent, MouseEvent } from "react"
import { usePathname } from "next/navigation"
import { ArrowLeft, BookOpen, ExternalLink, Search, Sparkles } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useAgentRail } from "@/components/agent/agent-rail-context"
import type { DocMeta, DocPage, HelpSearchResult } from "@/lib/docs"

/**
 * The rail's Help view: search the user guide, browse topics, read an article,
 * and hand a question to the agent.
 *
 * Same corpus as /help/[slug] and the MCP `search_help` / `get_help` tools —
 * reached through /api/help because lib/docs.ts is fs-based and server-only.
 *
 * The hand-off is `askAgent` (see agent-rail-context.tsx): it switches to the
 * Agent view, shows a context chip and prefills the composer. It never sends.
 */

/** Which guide covers the screen the user is on. Keyed by the route's third segment. */
const PAGE_TOPICS: Record<string, string[]> = {
  okrs: ["01-okrs"],
  discovery: ["02-discovery", "11-scoring-models"],
  solutions: ["02-discovery"],
  experiments: ["03-experiments"],
  roadmap: ["04-roadmap"],
  feedback: ["05-feedback"],
  docs: ["06-docs"],
  canvas: ["12-canvas"],
  tasks: ["13-tasks"],
  capture: ["16-capture"],
  decisions: ["17-decision-reviews"],
  reviews: ["17-decision-reviews"],
  "card-sort": ["26-card-sort"],
  updates: ["22-updates"],
  metrics: ["22-analytics"],
  agent: ["19-agents", "20-send-to-agent"],
  notifications: ["27-following"],
}

type Article = { doc: DocPage; anchor?: string }

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}

export function DocsPanel() {
  const { docsIntent, askAgent } = useAgentRail()
  const pathname = usePathname()

  const [topics, setTopics] = useState<DocMeta[] | null>(null)
  const [topicsError, setTopicsError] = useState(false)
  const [query, setQuery] = useState("")
  const debouncedQuery = useDebounced(query.trim(), 200)
  const [results, setResults] = useState<{ query: string; items: HelpSearchResult[] } | null>(null)
  const [article, setArticle] = useState<Article | null>(null)
  const [loadingSlug, setLoadingSlug] = useState<string | null>(null)
  const [articleError, setArticleError] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const handledIntent = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch("/api/help")
        if (!res.ok) throw new Error(String(res.status))
        const data = (await res.json()) as { topics: DocMeta[] }
        if (!cancelled) setTopics(data.topics)
      } catch {
        if (!cancelled) setTopicsError(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!debouncedQuery) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`/api/help?q=${encodeURIComponent(debouncedQuery)}`)
        if (!res.ok) throw new Error(String(res.status))
        const data = (await res.json()) as { results: HelpSearchResult[] }
        if (!cancelled) setResults({ query: debouncedQuery, items: data.results })
      } catch {
        if (!cancelled) setResults({ query: debouncedQuery, items: [] })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [debouncedQuery])

  const openArticle = useCallback(async (slug: string, anchor?: string) => {
    setLoadingSlug(slug)
    setArticleError(false)
    try {
      const res = await fetch(`/api/help?slug=${encodeURIComponent(slug)}`)
      if (!res.ok) throw new Error(String(res.status))
      const data = (await res.json()) as { doc: DocPage }
      setArticle({ doc: data.doc, anchor })
    } catch {
      setArticleError(true)
    } finally {
      setLoadingSlug(null)
    }
  }, [])

  // One-shot requests from elsewhere ("?" shortcut, future Help buttons).
  useEffect(() => {
    if (!docsIntent || handledIntent.current === docsIntent.id) return
    handledIntent.current = docsIntent.id
    if (docsIntent.slug) {
      void openArticle(docsIntent.slug, docsIntent.anchor)
    } else {
      setArticle(null)
      if (docsIntent.query !== undefined) setQuery(docsIntent.query)
      requestAnimationFrame(() => searchRef.current?.focus())
    }
  }, [docsIntent, openArticle])

  // Land on the anchor (or the top) whenever a different article is shown.
  useEffect(() => {
    if (!article) return
    const root = scrollRef.current
    if (!root) return
    const go = () => {
      if (article.anchor) {
        root.querySelector<HTMLElement>(`[id="${CSS.escape(article.anchor)}"]`)?.scrollIntoView({ block: "start" })
      } else {
        root.scrollTo({ top: 0 })
      }
    }
    go()
    // Screenshots have no reserved size and shift the layout as they load.
    const pending = Array.from(root.querySelectorAll<HTMLImageElement>("img")).filter((i) => !i.complete)
    pending.forEach((i) => i.addEventListener("load", go))
    return () => pending.forEach((i) => i.removeEventListener("load", go))
  }, [article])

  const pageTopics = useMemo(() => {
    if (!topics) return []
    const segment = pathname?.split("/").filter(Boolean)[2] ?? ""
    const slugs = PAGE_TOPICS[segment] ?? []
    return slugs.flatMap((s) => topics.find((t) => t.slug === s) ?? [])
  }, [topics, pathname])

  const sections = useMemo(() => {
    const out: { section: string; docs: DocMeta[] }[] = []
    for (const doc of topics ?? []) {
      let group = out.find((g) => g.section === doc.section)
      if (!group) out.push((group = { section: doc.section, docs: [] }))
      group.docs.push(doc)
    }
    return out
  }, [topics])

  const askAboutArticle = (doc: DocPage) =>
    askAgent({
      label: doc.title,
      summary: `User guide · ${doc.section}`,
      sourceUrl: `/help/${doc.slug}`,
      text: `About the "${doc.title}" guide: `,
    })

  const askAboutQuery = (q: string) =>
    askAgent({
      label: "Docs search",
      summary: `No guide answered “${q}”`,
      sourceUrl: "/help",
      text: q,
    })

  // Esc clears a search before it is allowed to close the rail.
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && query) {
      event.preventDefault()
      setQuery("")
    }
  }

  // Links inside an article that point at another guide stay in the rail.
  const onArticleClick = (event: MouseEvent<HTMLElement>) => {
    const anchor = (event.target as HTMLElement).closest("a")
    const href = anchor?.getAttribute("href")
    if (!href) return
    const match = /^(?:https?:\/\/[^/]+)?\/help\/([a-z0-9-]+)(?:#(.*))?$/i.exec(href)
    if (match) {
      event.preventDefault()
      void openArticle(match[1], match[2])
    } else if (href.startsWith("#") && article) {
      event.preventDefault()
      scrollRef.current?.querySelector<HTMLElement>(`[id="${CSS.escape(href.slice(1))}"]`)?.scrollIntoView({ block: "start" })
    } else if (/^https?:\/\//.test(href)) {
      anchor?.setAttribute("target", "_blank")
      anchor?.setAttribute("rel", "noreferrer")
    }
  }

  if (article) {
    const { doc } = article
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="docs-article">
        <div className="flex shrink-0 items-center gap-1 border-b border-border-default px-2 py-1.5">
          <Button variant="ghost" size="sm" onClick={() => setArticle(null)}>
            <ArrowLeft aria-hidden="true" />
            Docs
          </Button>
          <a
            href={`/help/${doc.slug}`}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 px-2 text-xs text-text-subtle hover:text-text-primary"
          >
            Open full page
            <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        </div>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3" onClick={onArticleClick}>
          <div className="docs-content text-sm" dangerouslySetInnerHTML={{ __html: doc.html }} />
        </div>
        <div className="shrink-0 border-t border-border-default p-3">
          <Button className="w-full" onClick={() => askAboutArticle(doc)}>
            <Sparkles aria-hidden="true" />
            Ask the agent about this
          </Button>
        </div>
      </div>
    )
  }

  const searching = query.trim() !== ""
  const current = searching && results?.query === debouncedQuery && debouncedQuery === query.trim() ? results : null

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="docs-home">
      <div className="shrink-0 border-b border-border-default p-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-text-subtle"
            aria-hidden="true"
          />
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder="Search the docs…"
            aria-label="Search the docs"
            className="pl-8"
          />
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {articleError && (
          <p role="alert" className="mb-3 rounded-lg border border-default bg-status-danger-surface px-3 py-2 text-sm text-status-danger">
            Couldn’t load that guide. Try again.
          </p>
        )}
        {loadingSlug && <p className="mb-3 text-xs text-text-subtle">Opening…</p>}

        {searching ? (
          <div>
            {current === null && <p className="text-xs text-text-subtle">Searching…</p>}
            {current && current.items.length > 0 && (
              <ul className="flex flex-col gap-1">
                {current.items.map((r) => (
                  <li key={`${r.slug}#${r.anchor ?? ""}`}>
                    <button
                      type="button"
                      onClick={() => void openArticle(r.slug, r.anchor ?? undefined)}
                      className="w-full rounded-lg px-2.5 py-2 text-left hover:bg-surface-interactive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="block text-[11px] uppercase tracking-wider text-text-subtle">{r.section}</span>
                      <span className="block text-sm font-medium text-text-primary">
                        {r.title}
                        {r.heading ? <span className="font-normal text-text-subtle"> › {r.heading}</span> : null}
                      </span>
                      <span className="mt-0.5 line-clamp-2 block text-xs text-text-subtle">{r.excerpt}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {current && current.items.length === 0 && (
              <p className="px-1 text-sm text-text-subtle">No guide matches “{current.query}”.</p>
            )}
            {current && (
              <Button variant="outline" className="mt-3 w-full" onClick={() => askAboutQuery(query.trim())}>
                <Sparkles aria-hidden="true" />
                Ask the agent instead
              </Button>
            )}
          </div>
        ) : (
          <>
            {topicsError && <p className="text-sm text-text-subtle">The docs couldn’t be loaded.</p>}
            {!topics && !topicsError && <p className="text-xs text-text-subtle">Loading…</p>}

            {pageTopics.length > 0 && (
              <section className="mb-5" aria-label="For this page">
                <h3 className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
                  For this page
                </h3>
                <ul className="flex flex-col gap-1">
                  {pageTopics.map((t) => (
                    <li key={t.slug}>
                      <button
                        type="button"
                        onClick={() => void openArticle(t.slug)}
                        className="flex w-full items-start gap-2 rounded-lg border border-border-default bg-surface-inset px-2.5 py-2 text-left hover:bg-surface-interactive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <BookOpen className="mt-0.5 size-3.5 shrink-0 text-text-subtle" aria-hidden="true" />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-text-primary">{t.title}</span>
                          <span className="line-clamp-2 block text-xs text-text-subtle">{t.description}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {sections.map((group) => (
              <section key={group.section} className="mb-5" aria-label={group.section}>
                <h3 className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
                  {group.section}
                </h3>
                <ul>
                  {group.docs.map((t) => (
                    <li key={t.slug}>
                      <button
                        type="button"
                        onClick={() => void openArticle(t.slug)}
                        className="w-full rounded-lg px-2.5 py-1.5 text-left text-sm text-text-primary hover:bg-surface-interactive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {t.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
