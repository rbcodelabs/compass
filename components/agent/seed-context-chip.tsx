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
import { Button } from "@/components/ui/button"

type Props = {
  label: string
  summary: string
  sourceUrl: string
  onDismiss: () => void
}

export function SeedContextChip({ label, summary, sourceUrl, onDismiss }: Props) {
  return (
    <div className="mx-auto flex w-full max-w-3xl items-start gap-2 rounded-lg border border-default bg-surface-inset px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <Link href={sourceUrl} className="font-medium text-text-primary underline-offset-2 hover:underline">
          {label}
        </Link>
        <p className="truncate text-xs text-text-subtle">{summary}</p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss context"
        className="shrink-0"
        onClick={onDismiss}
      >
        <XIcon aria-hidden="true" />
      </Button>
    </div>
  )
}
