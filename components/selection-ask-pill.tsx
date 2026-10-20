"use client"

// Floating actions next to a text selection on the page. It is only a shortcut
// into the Cmd+K palette (which already reads the selection on open), so it adds
// no behaviour of its own beyond showing, positioning and dismissing itself.

import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { Search, Sparkles } from "lucide-react"

import { isPillSelection, pillPosition } from "@/lib/selection-pill"
import { resolveSelectionContext, type SelectionContext } from "@/lib/selection-context"

type PillState = { text: string; context: SelectionContext | null; left: number; top: number }

const SETTLE_MS = 150

export function SelectionAskPill({
  disabled,
  slugs,
  onAsk,
  onFindSimilar,
}: {
  disabled: boolean
  /** The workspace the page belongs to, for building links back to entities. */
  slugs: { orgSlug: string; workspaceSlug: string }
  onAsk: (selection: string, context: SelectionContext | null) => void
  onFindSimilar: (selection: string) => void
}) {
  const [pill, setPill] = useState<PillState | null>(null)

  useEffect(() => {
    if (disabled) return
    let timer: number | undefined
    const evaluate = () => {
      const found = isPillSelection(window.getSelection(), document.activeElement)
      if (!found) return setPill(null)
      setPill({
        text: found.text,
        context: resolveSelectionContext(found.anchor, { pathname: window.location.pathname, search: window.location.search }, slugs),
        ...pillPosition(found.rect, { width: window.innerWidth, height: window.innerHeight }),
      })
    }
    // Selection changes fire continuously while dragging; wait for it to settle.
    const schedule = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(evaluate, SETTLE_MS)
    }
    const hide = () => {
      window.clearTimeout(timer)
      setPill(null)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide()
    }
    document.addEventListener("selectionchange", schedule)
    document.addEventListener("keydown", onKeyDown)
    // Capture: scrolling inside any container moves the selection under the pill.
    window.addEventListener("scroll", hide, true)
    window.addEventListener("resize", hide)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener("selectionchange", schedule)
      document.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("scroll", hide, true)
      window.removeEventListener("resize", hide)
    }
  }, [disabled, slugs.orgSlug, slugs.workspaceSlug])

  if (disabled || !pill) return null

  const act = (action: (selection: string, context: SelectionContext | null) => void) => () => {
    const { text, context } = pill
    setPill(null)
    action(text, context)
  }

  return createPortal(
    <div
      data-selection-pill
      // Popup layer (app/globals.css): the pill floats over the detail panel (60) and any dialog (70) a selection can sit in.
      role="toolbar"
      aria-label="Selection actions"
      style={{ left: pill.left, top: pill.top }}
      // Keeps the page selection alive through the click.
      onMouseDown={(event) => event.preventDefault()}
      className="fixed z-[80] flex -translate-x-1/2 items-center gap-1 rounded-full border bg-popover p-1 text-popover-foreground shadow-md"
    >
      <button
        type="button"
        title="Ask Compass about this (⌘K)"
        onClick={act(onAsk)}
        className="flex items-center gap-1.5 rounded-full px-3 py-1 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Sparkles className="size-3.5 text-primary" aria-hidden="true" />
        Ask…
      </button>
      <button
        type="button"
        onClick={act(onFindSimilar)}
        className="flex items-center gap-1.5 rounded-full px-3 py-1 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Search className="size-3.5 text-muted-foreground" aria-hidden="true" />
        Find similar
      </button>
    </div>,
    document.body,
  )
}
