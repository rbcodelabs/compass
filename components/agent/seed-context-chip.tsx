"use client"

// Dismissible context chip for the "Send to agent" hand-off (see
// lib/agent-context.ts). Shown above the composer when a fresh chat was
// opened from an approved Solution Plan or Decision Record.
//
// Dismissing only clears this chip's presence in the parent (agent-chat.tsx)
// — it must never touch the composer text, which the user may have already
// started editing independently of the suggested instruction.

import Link from "next/link"
import { XIcon } from "lucide-react"

type Props = {
  label: string
  summary: string
  sourceUrl: string
  onDismiss: () => void
}

/** A compact chip for the composer's context strip. The summary rides in the tooltip (and to screen readers) so the strip stays one line. */
export function SeedContextChip({ label, summary, sourceUrl, onDismiss }: Props) {
  return (
    <div title={summary || undefined} className="inline-flex h-6 min-w-0 max-w-full items-center gap-1 rounded-md border border-border bg-muted pr-0.5 pl-2 text-xs">
      <Link href={sourceUrl} className="min-w-0 truncate font-medium text-foreground underline-offset-2 hover:underline">
        {label}
      </Link>
      {/* Visible as a tooltip; always available to screen readers. */}
      <span className="sr-only">{summary}</span>
      <button
        type="button"
        aria-label="Dismiss context"
        onClick={onDismiss}
        className="relative grid size-[18px] shrink-0 place-items-center after:absolute after:-inset-[3px] after:content-[''] rounded text-muted-foreground outline-none hover:bg-sunken hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <XIcon className="size-3" aria-hidden="true" />
      </button>
    </div>
  )
}
