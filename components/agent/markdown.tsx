"use client"

import { createContext, useContext, type ComponentProps, type MouseEvent, type ReactNode } from "react"
import { MessageSquare } from "lucide-react"

import { AgentLink } from "@/components/agent/entity-link-card"
import { AgentImage } from "@/components/agent/agent-image"
import { chipClass } from "@/components/comments/mention-chips"
import { MarkdownContent } from "@/components/markdown-content"
import { mentionsAsMarkdownLinks, parseMentionHref } from "@/lib/comment-mentions"
import {
  clearBoardCardHighlights,
  highlightBoardCard,
  parseThreadLinkHref,
  rewriteThreadWikilinks,
} from "@/lib/orchestrator/thread-links"

type ThreadLinkNavigationContextValue = {
  basePath?: string
  onOpenThread?: (threadId: string) => void
}

const ThreadLinkNavigationContext = createContext<ThreadLinkNavigationContextValue | null>(null)

export function ThreadLinkNavigationProvider({
  basePath,
  onOpenThread,
  children,
}: ThreadLinkNavigationContextValue & { children: ReactNode }) {
  return (
    <ThreadLinkNavigationContext.Provider value={{ basePath, onOpenThread }}>
      {children}
    </ThreadLinkNavigationContext.Provider>
  )
}

function ThreadChipLink({ threadId, children }: { threadId: string; children?: ReactNode }) {
  const nav = useContext(ThreadLinkNavigationContext)
  const href = nav?.basePath ? `${nav.basePath}/agent?c=${encodeURIComponent(threadId)}` : `?c=${encodeURIComponent(threadId)}`

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    clearBoardCardHighlights()
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    if (nav?.onOpenThread) {
      e.preventDefault()
      nav.onOpenThread(threadId)
    }
  }

  return (
    <a
      href={href}
      data-testid="thread-link-chip"
      data-thread-link={threadId}
      onMouseEnter={() => {
        highlightBoardCard(threadId, { scroll: true })
      }}
      onMouseLeave={() => {
        clearBoardCardHighlights()
      }}
      onFocus={() => {
        highlightBoardCard(threadId, { scroll: true })
      }}
      onBlur={() => {
        clearBoardCardHighlights()
      }}
      onClick={handleClick}
      className="inline-flex items-center gap-1 rounded-md border border-border-default bg-surface-inset px-1.5 py-0.5 align-baseline text-xs font-medium text-text-primary no-underline transition-colors hover:border-status-info/60 hover:bg-status-info-surface hover:text-status-info focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <MessageSquare aria-hidden="true" className="size-3 shrink-0 text-status-info" />
      <span>{children}</span>
    </a>
  )
}

function AgentMarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const mention = parseMentionHref(href)
  if (mention) {
    return (
      <span
        data-testid="comment-mention"
        data-mention-id={mention.id}
        className={chipClass(mention.kind, mention.outside)}
      >
        {children}
      </span>
    )
  }
  const threadId = parseThreadLinkHref(href)
  if (threadId) {
    return <ThreadChipLink threadId={threadId}>{children}</ThreadChipLink>
  }
  return <AgentLink href={href}>{children}</AgentLink>
}

/**
 * Agent transcript markdown: Compass entity links render as live cards (see
 * entity-link-card.tsx), orchestrator `[[thread:<id>|Title]]` markers render as
 * interactive board-highlighting thread chips, and workspace images render inline.
 */
export function Markdown({
  children,
  ...props
}: Omit<ComponentProps<typeof MarkdownContent>, "linkComponent" | "imageComponent">) {
  const rewritten = mentionsAsMarkdownLinks(rewriteThreadWikilinks(children))
  return (
    <MarkdownContent {...props} linkComponent={AgentMarkdownLink} imageComponent={AgentImage}>
      {rewritten}
    </MarkdownContent>
  )
}
