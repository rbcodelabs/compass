"use client"

import { useEffect, useRef } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { decodeConversationId, RAIL_CONVERSATION_PARAM } from "@/lib/agent-rail-url"

const DETAIL_PARAM = "detail"

/**
 * Old rail links looked like `?rc=<id>`. The rail no longer owns a thread
 * view, so on first mount we rewrite such a URL to the panel's own
 * `?detail=conversation:<id>` form. An existing `detail` wins and `rc` is
 * simply dropped. Uses replace(), so no history entry is added; other params
 * (including rail=help|library and ra) pass through untouched.
 */
export function LegacyRailLinkRedirect() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const handled = useRef(false)

  useEffect(() => {
    if (handled.current) return
    handled.current = true
    const id = decodeConversationId(searchParams.get(RAIL_CONVERSATION_PARAM))
    if (!id) return
    const next = new URLSearchParams(searchParams.toString())
    next.delete(RAIL_CONVERSATION_PARAM)
    if (!next.has(DETAIL_PARAM)) next.set(DETAIL_PARAM, `conversation:${id}`)
    const qs = next.toString()
    router.replace(`${pathname}${qs ? `?${qs}` : ""}${window.location.hash}`, { scroll: false })
    // First mount only: the URL seeds the redirect and never drives it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
}
