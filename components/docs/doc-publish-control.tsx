"use client"

import { useId, useRef, useState } from "react"
import { Check, Info, Link2 } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { StatusBadge } from "@/components/patterns/status-badge"
import { pushUndoToast } from "@/lib/ui/undo-toast"

export const PUBLISH_INFO_COPY = "Visible to anyone with the portal link. Unpublishing removes it immediately."

export interface DocPublishControlProps {
  docId: string
  orgSlug: string
  workspaceSlug: string
  /** ISO timestamp when published, null when not. Server truth at page load. */
  initialPublishedAt: string | null
  /** False for docs whose body cannot be public (externally stored, canvas). */
  publishable: boolean
  /** False for read-only viewers of the workspace. */
  canPublish: boolean
}

/** The absolute customer URL of a published doc. */
export function portalDocUrl(origin: string, orgSlug: string, workspaceSlug: string, docId: string): string {
  return `${origin}/portal/${orgSlug}/${workspaceSlug}/docs/${docId}`
}

/**
 * Publish control in the doc header: a switch, a state badge, "Copy public link" and an info popover.
 * Optimistic: the switch flips immediately and rolls back with an error toast if POST /api/docs/[id]/publish
 * fails. Authorization is enforced by that route; disabling here is only explanation, never the gate.
 */
export function DocPublishControl({ docId, orgSlug, workspaceSlug, initialPublishedAt, publishable, canPublish }: DocPublishControlProps) {
  const [published, setPublished] = useState(initialPublishedAt !== null)
  const [pending, setPending] = useState(false)
  const [status, setStatus] = useState("")
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const labelId = useId()

  const disabledReason = !publishable
    ? "This doc's content is stored outside Compass (or is a canvas), so it cannot be published to the portal yet."
    : !canPublish
      ? "You have read-only access to this workspace, so you cannot publish docs."
      : null

  async function toggle(next: boolean) {
    if (pending || disabledReason) return
    const previous = published
    setPublished(next)
    setPending(true)
    setStatus("")
    try {
      const response = await fetch(`/api/docs/${docId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ published: next }),
      })
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null
        throw new Error(payload?.error ?? "Could not update publishing")
      }
      const payload = (await response.json()) as { published: boolean }
      setPublished(payload.published)
      setStatus(payload.published ? "Published. Visible to anyone with the portal link." : "Unpublished. Removed from the portal immediately.")
    } catch (error) {
      setPublished(previous)
      const message = error instanceof Error ? error.message : "Could not update publishing"
      setStatus(message)
      pushUndoToast({ message: `${next ? "Publish" : "Unpublish"} failed: ${message}`, tone: "default" })
    } finally {
      setPending(false)
    }
  }

  async function copyLink() {
    const url = portalDocUrl(window.location.origin, orgSlug, workspaceSlug, docId)
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      pushUndoToast({ message: "Public link copied", durationMs: 3000 })
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      pushUndoToast({ message: "Could not copy the link. Copy it from the address bar of the portal page.", durationMs: 5000 })
    }
  }

  const switchEl = (
    <Switch
      checked={published}
      disabled={pending || disabledReason !== null}
      onCheckedChange={(next) => void toggle(next === true)}
      aria-labelledby={labelId}
      data-testid="doc-publish-switch"
    />
  )

  return (
    <div className="mx-auto w-full max-w-4xl px-8 pb-2" data-testid="doc-publish-control" data-published={published}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-border-default bg-surface-inset px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger render={<span tabIndex={disabledReason ? 0 : -1} className="inline-flex items-center gap-2" />}>
                {switchEl}
                <span id={labelId} className="text-sm font-medium text-text-primary">Publish to portal</span>
              </TooltipTrigger>
              {disabledReason ? <TooltipContent>{disabledReason}</TooltipContent> : null}
            </Tooltip>
          </TooltipProvider>
          {published ? (
            <StatusBadge status="success" icon={<Check aria-hidden />} data-testid="doc-publish-badge">Published to portal</StatusBadge>
          ) : (
            <StatusBadge status="neutral" data-testid="doc-publish-badge">{disabledReason && !publishable ? "Not publishable" : "Not published · Draft"}</StatusBadge>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Popover>
            <PopoverTrigger
              aria-label="About publishing"
              className="inline-flex size-7 items-center justify-center rounded-md text-text-subtle hover:bg-muted hover:text-text-primary focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <Info className="size-4" aria-hidden />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 rounded-lg border border-border-default bg-surface-card p-3 text-sm leading-5 text-text-secondary shadow-md">
              <p className="font-medium text-text-primary">Visible to anyone with the portal link</p>
              <p className="mt-1">{PUBLISH_INFO_COPY}</p>
            </PopoverContent>
          </Popover>
          {published ? (
            <Button type="button" variant="outline" size="sm" onClick={() => void copyLink()} data-testid="doc-publish-copy">
              {copied ? <Check aria-hidden /> : <Link2 aria-hidden />}
              {copied ? "Link copied" : "Copy public link"}
            </Button>
          ) : null}
        </div>
      </div>
      <p className="sr-only" role="status" aria-live="polite">{status}</p>
    </div>
  )
}
