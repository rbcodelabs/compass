"use client"

import { useId, useRef, useState } from "react"
import { Check, Info, Link2 } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
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
 * Publish control in the doc header: a small switch, a short state word, an info popover and, once published, "Copy link".
 * Optimistic: the switch flips immediately and rolls back with an error toast if POST /api/docs/[id]/publish
 * fails. Authorization is enforced by that route; disabling here is only explanation, never the gate.
 */
export function DocPublishControl({ docId, orgSlug, workspaceSlug, initialPublishedAt, publishable, canPublish }: DocPublishControlProps) {
  const [published, setPublished] = useState(initialPublishedAt !== null)
  const [pending, setPending] = useState(false)
  const [status, setStatus] = useState("")
  const [copied, setCopied] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const infoId = useId()

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
      aria-label="Publish to portal"
      data-testid="doc-publish-switch"
    />
  )

  return (
    <div className="relative shrink-0" data-testid="doc-publish-control" data-published={published} onKeyDown={(event) => { if (event.key === "Escape") setInfoOpen(false) }}>
      <div className="flex items-center gap-1.5">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger render={<span tabIndex={disabledReason ? 0 : -1} className="inline-flex items-center gap-1.5" />}>
              {switchEl}
              <span className="text-xs font-medium text-text-secondary">Publish</span>
            </TooltipTrigger>
            {disabledReason ? <TooltipContent>{disabledReason}</TooltipContent> : null}
          </Tooltip>
        </TooltipProvider>
        {published ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-status-success" data-testid="doc-publish-badge">
            <Check className="size-3" aria-hidden />
            <span>Published</span>
            <span className="sr-only"> to portal</span>
          </span>
        ) : (
          <span className="text-xs text-text-subtle" data-testid="doc-publish-badge">
            <span aria-hidden>{disabledReason && !publishable ? "Not publishable" : "Draft"}</span>
            <span className="sr-only">{disabledReason && !publishable ? "Not publishable" : "Not published · Draft"}</span>
          </span>
        )}
        {/* A small popover under the control: the page header has no sticky toolbar below it on desktop to cover. */}
        <button
          type="button"
          aria-label="About publishing"
          aria-expanded={infoOpen}
          aria-controls={infoId}
          onClick={() => setInfoOpen((open) => !open)}
          className="inline-flex size-6 items-center justify-center rounded-md text-text-subtle hover:bg-muted hover:text-text-primary focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <Info className="size-3.5" aria-hidden />
        </button>
        {published ? (
          <Button type="button" variant="ghost" size="xs" onClick={() => void copyLink()} data-testid="doc-publish-copy" aria-label="Copy public link">
            {copied ? <Check aria-hidden /> : <Link2 aria-hidden />}
            {copied ? "Copied" : "Copy link"}
          </Button>
        ) : null}
      </div>
      {infoOpen ? (
        <p id={infoId} className="absolute right-0 top-full z-30 mt-1 w-64 rounded-lg border border-border-default bg-surface-card p-3 text-xs leading-5 text-text-secondary shadow-md" data-testid="doc-publish-info">{PUBLISH_INFO_COPY}</p>
      ) : null}
      <p className="sr-only" role="status" aria-live="polite">{status}</p>
    </div>
  )
}
