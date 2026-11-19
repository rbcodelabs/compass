"use client"

import { useEffect } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { decodeConversationId, RAIL_CONVERSATION_PARAM } from "@/lib/agent-rail-url"

const DETAIL_PARAM = "detail"

/**
 * Old rail links looked like `?rc=<id>`. The rail no longer owns a thread
 * view, so whenever `rc` is present (first load or a later client-side
 * navigation to such a link) we rewrite such a URL to the panel's own
 * `?detail=conversation:<id>` form. An existing `detail` wins and `rc` is
 * simply dropped. Uses replace(), so no history entry is added; other params
 * (including rail=help|library and ra) pass through untouched.
 */
export function LegacyRailLinkRedirect() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const rc = searchParams.get(RAIL_CONVERSATION_PARAM)

  // Keyed on `rc` alone: the redirect removes it, so it cannot loop, and a
  // second run (StrictMode, or a re-render before the URL settles) at worst
  // repeats an identical replace().
  useEffect(() => {
    const id = decodeConversationId(rc)
    if (!id) return
    const next = new URLSearchParams(searchParams.toString())
    next.delete(RAIL_CONVERSATION_PARAM)
    if (!next.has(DETAIL_PARAM)) next.set(DETAIL_PARAM, `conversation:${id}`)
    const qs = next.toString()
    router.replace(`${pathname}${qs ? `?${qs}` : ""}${window.location.hash}`, { scroll: false })
    // searchParams/pathname/router are read at fire time; only a new `rc` re-fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rc])

  return null
}
