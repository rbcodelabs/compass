"use client"

import { useEffect, useRef, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { X } from "lucide-react"
import { useConversationPanelOptional } from "@/components/panels/conversation-panel"
import { canonicalCommentDeepLink, isCommentId, withoutCommentParam } from "@/lib/comment-deep-link"

/**
 * Opens the Conversation panel for an old comment-origin link (`<object page>?comment=<id>`), TASK-195 S3.
 *
 * Mounted once inside ConversationPanelProvider. When the URL carries `comment=<id>` and no panel, it asks
 * GET /api/agent/conversations/locate which conversation holds that id and rewrites the URL with `router.replace` (no
 * history entry) to `?detail=conversation:<cid>&comment=<messageId>`. The panel reads `comment` to highlight the message,
 * so a refresh or a shared link lands in the same place. Other parameters and the hash are kept.
 *
 *  - Idempotent and loop-free: a URL that already has a conversation panel is trusted and never looked up; an id is looked
 *    up once per page life. Another open panel is left alone.
 *  - Closing the panel leaves `comment` behind (closePanel only removes `detail`), so once an id this opener opened is no
 *    longer shown it is dropped from the URL instead of reopening the panel.
 *  - A Docs comment (targetType DOC) belongs to the Docs sidebar, which reads `?comment=` itself: left untouched.
 *  - An unknown, malformed or unreadable id gets one neutral note and the parameter is dropped. The note never says which
 *    of those it was. A failed lookup (offline, 5xx) changes nothing.
 */
const DETAIL_PREFIX = "conversation:"

type Located = { conversationId: string; messageId: string; targetType: string | null }

function parseLocated(value: unknown): Located | null {
  if (!value || typeof value !== "object") return null
  const { conversationId, messageId, targetType } = value as Record<string, unknown>
  if (!isCommentId(typeof conversationId === "string" ? conversationId : null)) return null
  if (typeof messageId !== "string" || messageId.length === 0) return null
  return { conversationId: conversationId as string, messageId, targetType: typeof targetType === "string" ? targetType : null }
}

export function CommentDeepLinkOpener() {
  const ctx = useConversationPanelOptional()
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [notice, setNotice] = useState(false)
  // Set once an id has been dealt with; `opened` means this opener (or a canonical link) put its thread in the panel.
  const handled = useRef<{ id: string; opened: boolean } | null>(null)
  const replaceRef = useRef(router.replace)
  replaceRef.current = router.replace

  const workspaceId = ctx?.workspaceId
  const comment = searchParams.get("comment")
  const detail = searchParams.get("detail")
  const search = searchParams.toString()

  useEffect(() => {
    if (!workspaceId || !pathname) return
    if (!comment) {
      handled.current = null
      return
    }
    // The full-page Conversations screen has its own `?c=` addressing.
    if (pathname.endsWith("/conversations")) return
    const parts = () => ({ pathname, search, hash: window.location.hash })
    const replace = (href: string) => replaceRef.current(href, { scroll: false })

    if (detail?.startsWith(DETAIL_PREFIX)) {
      // Already canonical (our own rewrite, a shared link or a reload): nothing to look up.
      handled.current = { id: comment, opened: true }
      return
    }
    if (detail) return // another panel is open; it wins

    if (handled.current?.id === comment) {
      if (handled.current.opened) {
        // The panel was closed; do not let the stale parameter reopen it.
        handled.current = null
        replace(withoutCommentParam(parts()))
      }
      return
    }

    if (!isCommentId(comment)) {
      handled.current = { id: comment, opened: false }
      setNotice(true)
      replace(withoutCommentParam(parts()))
      return
    }

    const controller = new AbortController()
    void (async () => {
      let located: Located | null = null
      let status = 0
      try {
        const response = await fetch(
          `/api/agent/conversations/locate?workspaceId=${encodeURIComponent(workspaceId)}&messageId=${encodeURIComponent(comment)}`,
          { signal: controller.signal },
        )
        status = response.status
        if (response.ok) located = parseLocated(await response.json())
      } catch {
        // Offline or a transient failure: change nothing, do not retry in a loop.
      }
      if (controller.signal.aborted) return
      handled.current = { id: comment, opened: false }
      if (status === 404) {
        setNotice(true)
        replace(withoutCommentParam(parts()))
        return
      }
      if (!located || located.targetType === "DOC") return
      handled.current = { id: comment, opened: true }
      replace(canonicalCommentDeepLink({ ...parts(), conversationId: located.conversationId, messageId: located.messageId }))
    })()
    return () => controller.abort()
  }, [workspaceId, pathname, comment, detail, search])

  if (!notice) return null
  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-lg border border-default bg-surface-card px-4 py-2 text-sm text-text-secondary shadow-md"
    >
      <span>That conversation isn’t available.</span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setNotice(false)}
        className="grid size-6 place-items-center rounded text-text-subtle outline-none hover:bg-surface-interactive focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}
