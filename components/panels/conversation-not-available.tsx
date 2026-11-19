"use client"

import { useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { usePanelContext } from "@/components/panels/panel-context"

/**
 * Shown in the Conversation panel when its id cannot be read. One state for
 * "does not exist" and "exists but you may not read it": the same markup and the
 * same words, and nothing about the conversation is ever rendered here.
 */
export function ConversationNotAvailable() {
  const { closePanel } = usePanelContext()
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <div
      role="status"
      data-testid="conversation-not-available"
      className="flex flex-1 flex-col items-start gap-3 p-6"
    >
      <h2 ref={headingRef} tabIndex={-1} className="text-base font-semibold outline-none">
        Not available
      </h2>
      <p className="text-sm text-text-subtle">
        This conversation is not available. It may have been removed, or you may not have access to it.
      </p>
      <Button variant="outline" size="sm" onClick={closePanel}>
        Close panel
      </Button>
    </div>
  )
}
