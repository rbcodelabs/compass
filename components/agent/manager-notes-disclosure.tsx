"use client"

import { useState } from "react"
import { ChevronDown, ChevronRight, NotebookPen } from "lucide-react"
import { formatRelativeTime, type AgentBoardCardManagerNotes } from "@/lib/agent-board"
import { cn } from "@/lib/utils"

type ManagerNotesDisclosureProps = {
  notes: AgentBoardCardManagerNotes
  now?: number
  className?: string
}

/**
 * Read-only collapsible disclosure displaying the caller's orchestrator Manager Notes v2
 * (`Notes · updated Xm ago`) using an accessible disclosure toggle.
 */
export function ManagerNotesDisclosure({
  notes,
  now,
  className,
}: ManagerNotesDisclosureProps) {
  const [open, setOpen] = useState(false)

  if (!notes.text.trim()) return null

  return (
    <div
      data-testid="manager-notes-disclosure"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className={cn(
        "relative z-10 rounded-lg border border-border-default/70 bg-surface-inset/60 text-left",
        className,
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        data-testid="manager-notes-toggle"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1 text-[11px] font-medium text-text-subtle transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <span className="inline-flex items-center gap-1.5">
          {open ? (
            <ChevronDown aria-hidden="true" className="size-3 shrink-0" />
          ) : (
            <ChevronRight aria-hidden="true" className="size-3 shrink-0" />
          )}
          <NotebookPen aria-hidden="true" className="size-3 shrink-0 text-text-secondary" />
          <span>Notes</span>
          {notes.updatedAt && (
            <span className="text-[10px] font-normal text-text-subtle">
              · updated {formatRelativeTime(notes.updatedAt, now)}
            </span>
          )}
        </span>
      </button>

      {open && (
        <div
          data-testid="manager-notes-content"
          className="border-t border-border-default/60 px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-text-secondary"
        >
          {notes.text}
        </div>
      )}
    </div>
  )
}
