"use client"

import { useEffect, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react"
import Link from "next/link"
import { ArrowUpRight } from "lucide-react"

import { parseEntityLink, type ParsedEntityLink } from "@/lib/entity-links"
import type { EntitySummary } from "@/lib/entity-summary"
import { Badge } from "@/components/ui/badge"
import { useOptionalPanelContext, type PanelType } from "@/components/panels/panel-context"
import { useWorkItemLinkScope } from "@/components/work-item-link-scope"
import { cn } from "@/lib/utils"

/**
 * Renders a Compass link in the agent transcript as a live card: the entity's
 * current title and state, fetched from /api/panels/entity-summary, instead of a
 * bare URL. Anything that is not a recognised entity link — another host, a page
 * link, a link the reader cannot open — stays an ordinary anchor, so a card is
 * only ever an upgrade and never hides a link.
 */

const REVALIDATE_AFTER_MS = 15_000

type Entry = { summary: EntitySummary | null; fetchedAt: number }
// Module scope on purpose: a streaming reply re-renders the markdown on every
// chunk, and a transcript can mention the same entity several times. The cache
// keeps a repeat card from flashing a skeleton; the in-flight map dedupes fetches.
const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<Entry | null>>()

function cacheKey(link: ParsedEntityLink): string {
  return `${link.orgSlug}/${link.workspaceSlug}/${link.type}/${link.id}`
}

function load(link: ParsedEntityLink): Promise<Entry | null> {
  const key = cacheKey(link)
  const pending = inflight.get(key)
  if (pending) return pending
  const qs = new URLSearchParams({ orgSlug: link.orgSlug, workspaceSlug: link.workspaceSlug, type: link.type, id: link.id })
  const request = fetch(`/api/panels/entity-summary?${qs}`)
    .then(async (res): Promise<Entry | null> => {
      if (res.ok) return { summary: (await res.json()) as EntitySummary, fetchedAt: Date.now() }
      // 401/403/404: the reader cannot see this (or it is gone). Remember that so
      // the link stays a plain link without being re-asked on every render.
      if (res.status === 401 || res.status === 403 || res.status === 404) return { summary: null, fetchedAt: Date.now() }
      return null // transient (5xx) — do not cache
    })
    .catch(() => null)
    .finally(() => inflight.delete(key))
  inflight.set(key, request)
  return request
}

function useEntitySummary(link: ParsedEntityLink | null): { summary: EntitySummary | null; settled: boolean } {
  const key = link ? cacheKey(link) : null
  const [, bump] = useState(0)
  const entry = key ? cache.get(key) : undefined

  useEffect(() => {
    if (!link || !key) return
    let cancelled = false
    const refresh = () => {
      const current = cache.get(key)
      if (current && Date.now() - current.fetchedAt < REVALIDATE_AFTER_MS) return
      void load(link).then((next) => {
        if (cancelled || !next) return
        cache.set(key, next)
        bump((n) => n + 1)
      })
    }
    refresh()
    // "Live": pick up edits made elsewhere whenever the reader comes back to the tab.
    const onVisible = () => { if (document.visibilityState === "visible") refresh() }
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("focus", refresh)
    return () => {
      cancelled = true
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("focus", refresh)
    }
    // `link` is rebuilt per render; `key` is its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return { summary: entry?.summary ?? null, settled: entry !== undefined }
}

function humanize(value: string): string {
  const spaced = value.replace(/_/g, " ").toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

// A real <a> whose children are all <span>s: it sits inside the <p>/<li> markdown
// wraps it in without producing invalid block-in-paragraph nesting.
const CARD =
  "my-1.5 block max-w-full rounded-lg border border-default bg-surface-inset px-3 py-2 text-text-primary! no-underline! transition hover:border-border-strong"

const subscribeNever = () => () => {}

// Types whose canonical location is the workspace-global ?detail= panel (see entityPath in
// lib/entity-links.ts). The panel mounts in the workspace layout, so it opens on whatever page the
// reader is already on; navigating to the link instead drags them off that page (a solution link
// points at its opportunity's discovery page) just to show the same panel.
const PANEL_ADDRESSED: ReadonlySet<string> = new Set(["solution", "assumption", "feedback", "objective", "keyResult", "roadmapItem"])

export function AgentLink({ href, children }: { href?: string; children?: ReactNode }) {
  // Absolute links only count when they point at this same origin, which is only
  // knowable in the browser — resolved after mount so SSR and hydration agree.
  const origin = useSyncExternalStore(subscribeNever, () => window.location.origin, () => null)

  const link = href ? parseEntityLink(href, origin) : null
  const panels = useOptionalPanelContext()
  const scope = useWorkItemLinkScope()
  const { summary, settled } = useEntitySummary(link)

  if (!href) return <span>{children}</span>
  const external = /^(?:https?:)?\/\//i.test(href)
  const plain = (
    <a href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
      {children}
    </a>
  )
  if (!link || (settled && !summary)) return plain

  if (!summary) {
    return (
      <a href={href} className={cn(CARD, "animate-pulse")} aria-busy="true">
        <span className="block h-3 w-16 rounded bg-surface-interactive" />
        <span className="mt-1.5 block h-4 w-2/3 rounded bg-surface-interactive" />
      </a>
    )
  }

  // Same-origin, so use the client router: the chat (and the rail) keep their state.
  const internalHref = external ? new URL(href).pathname + new URL(href).search : href
  // Same workspace as the page we are on: open the panel in place. Anything else (another workspace,
  // outside a panel provider, a page-owning type) keeps the real navigation, as does a modified click
  // so open-in-new-tab still works.
  const openInPlace =
    panels !== null &&
    scope !== null &&
    link !== null &&
    PANEL_ADDRESSED.has(link.type) &&
    link.orgSlug === scope.orgSlug &&
    link.workspaceSlug === scope.workspaceSlug
  const onClick = openInPlace && link
    ? (event: MouseEvent<HTMLAnchorElement>) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        panels.openPanel(link.type as PanelType, link.id)
      }
    : undefined
  return (
    <Link href={internalHref} onClick={onClick} data-entity-card={summary.type} className={cn(CARD, "group/card")}>
      <span className="flex items-center justify-between gap-2 text-xs text-text-subtle">
        <span className="truncate">{[summary.typeLabel, summary.meta].filter(Boolean).join(" · ")}</span>
        <ArrowUpRight className="size-3.5 shrink-0 opacity-0 transition group-hover/card:opacity-100" aria-hidden="true" />
      </span>
      <span className="mt-0.5 flex items-start justify-between gap-2">
        <span className="min-w-0 text-sm font-medium leading-5">{summary.title}</span>
        {summary.status && (
          <Badge variant="secondary" className="shrink-0">
            {humanize(summary.status)}
          </Badge>
        )}
      </span>
      {summary.description && (
        <span className="mt-1 line-clamp-2 block text-xs leading-4 text-text-secondary">{summary.description}</span>
      )}
    </Link>
  )
}
