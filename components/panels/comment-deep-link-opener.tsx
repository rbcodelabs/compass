"use client"

import { useEffect, useRef, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { X } from "lucide-react"
import { useConversationPanelOptional } from "@/components/panels/conversation-panel"
import { canonicalCommentDeepLink, isCommentId, withoutCommentParam } from "@/lib/comment-deep-link"

/**
 * Opens the Conversation panel for an old comment-origin link (`<object page>?comment=<id>`), TASK-195 S3.
 *
 * Mounted once inside ConversationPanelProvider. When the URL carries `comment=<id>` and no other panel, it asks
 * GET /api/agent/conversations/locate which conversation holds that id and rewrites the URL with `router.replace` (no
 * history entry) to `?detail=conversation:<cid>&comment=<messageId>`. The panel reads `comment` to highlight the message,
 * so a refresh or a shared link lands in the same place. Other parameters and the hash are kept.
 *
 *  - Loop-free: an id is looked up once per page life (a pair we wrote ourselves is remembered and never re-checked).
 *    A canonical URL met cold (reload, shared link) is checked once, and nothing is rewritten when it already matches. A
 *    `?comment=B` link followed while the panel shows conversation A looks B up and moves the panel to B's thread.
 *  - Another panel (`detail=task:...`) wins and its `comment` is never acted on, not even after that panel closes.
 *  - A legacy `rc` link is consumed by LegacyRailLinkRedirect first: while `rc` is in the URL this does nothing, so two
 *    `router.replace` calls built from the same stale URL cannot fight.
 *  - Closing the panel leaves `comment` behind (closePanel only removes `detail`), so once an id this opener opened is no
 *    longer shown it is dropped from the URL instead of reopening the panel.
 *  - A Docs comment (targetType DOC) belongs to the Docs sidebar, which reads `?comment=` itself: left untouched, and on
 *    `/docs` routes no lookup is made at all (every `comment` id there is a document comment).
 *  - An unknown, malformed or unreadable id gets one neutral note and the parameter is dropped. The note never says which
 *    of those it was. A failed lookup (offline, 5xx) changes nothing and is retried a few times with a growing delay.
 *
 * Cost and abuse: the lookup is two primary-key reads for a member; the only write is the idempotent, insert-only repair of
 * a missing mirror for a workspace member, so there is no per-user rate limit here. If locate ever becomes a probing target,
 * add one at the route (the 404 body is already uniform).
 */
const DETAIL_PREFIX = "conversation:"
const MAX_ATTEMPTS = 3
const RETRY_BASE_MS = 3000

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
  const [retry, setRetry] = useState(0)
  // Set once an id has been dealt with; `opened` means a conversation for it was put in the panel by this opener.
  const handled = useRef<{ id: string; opened: boolean } | null>(null)
  // `<conversationId>|<commentId>` pairs known to be right (written by us, or confirmed by a lookup).
  const confirmed = useRef<string | null>(null)
  const attempts = useRef(0)
  const replaceRef = useRef(router.replace)
  // Refs are written in an effect, not during render. This runs before the opener effect below (same commit, declaration order),
  // so that effect always sees the latest router.replace.
  useEffect(() => {
    replaceRef.current = router.replace
  })

  const workspaceId = ctx?.workspaceId
  const comment = searchParams.get("comment")
  const detail = searchParams.get("detail")
  const hasLegacyRail = searchParams.has("rc")
  const search = searchParams.toString()

  useEffect(() => {
    if (!workspaceId || !pathname) return
    if (!comment) {
      handled.current = null
      confirmed.current = null
      attempts.current = 0
      return
    }
    // The legacy `rc` redirect rewrites the URL first; acting on the same stale URL would leave `rc` behind.
    if (hasLegacyRail) return
    // The full-page Conversations screen has its own `?c=` addressing; Docs routes own their `comment` ids.
    if (pathname.endsWith("/conversations") || /\/docs(\/|$)/.test(pathname)) return
    const parts = () => ({ pathname, search, hash: window.location.hash })
    const replace = (href: string) => replaceRef.current(href, { scroll: false })

    const openConversationId = detail?.startsWith(DETAIL_PREFIX) ? detail.slice(DETAIL_PREFIX.length) : null
    if (detail && openConversationId === null) {
      // Another panel is open; it wins, and this id is not reopened when that panel closes.
      handled.current = { id: comment, opened: false }
      return
    }
    if (openConversationId && confirmed.current === `${openConversationId}|${comment}`) {
      handled.current = { id: comment, opened: true }
      return
    }
    if (!openConversationId && handled.current?.id === comment) {
      if (handled.current.opened) {
        // The panel was closed; do not let the stale parameter reopen it.
        handled.current = null
        confirmed.current = null
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
    let timer: ReturnType<typeof setTimeout> | undefined
    void (async () => {
      let located: Located | null = null
      let status = 0
      let failed = false
      try {
        const response = await fetch(
          `/api/agent/conversations/locate?workspaceId=${encodeURIComponent(workspaceId)}&messageId=${encodeURIComponent(comment)}`,
          { signal: controller.signal },
        )
        status = response.status
        if (response.ok) located = parseLocated(await response.json())
        failed = status !== 404 && !located
      } catch {
        failed = true
      }
      if (controller.signal.aborted) return
      if (status === 404) {
        handled.current = { id: comment, opened: false }
        setNotice(true)
        replace(withoutCommentParam(parts()))
        return
      }
      if (failed || !located) {
        // Offline or a transient failure: change nothing now, try again a few times.
        if (attempts.current < MAX_ATTEMPTS) {
          attempts.current += 1
          timer = setTimeout(() => setRetry((count) => count + 1), RETRY_BASE_MS * attempts.current)
        }
        return
      }
      attempts.current = 0
      if (located.targetType === "DOC") {
        handled.current = { id: comment, opened: false }
        return
      }
      handled.current = { id: comment, opened: true }
      confirmed.current = `${located.conversationId}|${comment}`
      if (openConversationId === located.conversationId) return // already showing the right thread
      replace(canonicalCommentDeepLink({ ...parts(), conversationId: located.conversationId, messageId: located.messageId }))
    })()
    return () => {
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [workspaceId, pathname, comment, detail, search, hasLegacyRail, retry])

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
