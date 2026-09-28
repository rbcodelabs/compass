"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { ArrowLeft, Maximize2, MessageSquarePlus } from "lucide-react"
import { ArtifactPreview, type AnchorRequest, type AnchorResolutionMap, type PickedElement } from "./artifact-preview"
import { Button, buttonVariants } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { ElementFingerprint } from "@/lib/artifact-anchor-match"

type AnchoredComment = {
  id: string
  authorName: string
  body: string
  elementAnchor?: { elementSelector: string | null; elementFingerprint: unknown } | null
}

/**
 * Wraps ArtifactPreview with the native, same-origin "leave feedback" picker
 * and the pins for previously-anchored comments — shared by the docked
 * artifact detail view and the full-screen route so both get identical
 * pick/comment/pin behavior rather than two implementations drifting apart.
 *
 * Deliberately does its own small GET of `/api/comments` rather than reading
 * from the Discussion component's (components/comments/discussion.tsx)
 * internal state: Discussion only fetches once its panel has been opened at
 * least once, but pins need to render whenever the viewer is on screen,
 * panel open or not.
 */
export function ArtifactViewer({
  title,
  html,
  externalUrl,
  artifactId,
  fullScreenHref,
  backHref,
  onFeedbackPosted,
  fill = false,
}: {
  title: string
  html?: string
  externalUrl?: string | null
  artifactId: string
  /** Present only in the docked view — links out to the full-screen route. */
  fullScreenHref?: string
  /** Present only in the full-screen view — links back to the docked artifact page. */
  backHref?: string
  /** Called after a feedback comment is successfully posted (e.g. to refresh a sibling Discussion panel). */
  onFeedbackPosted?: () => void
  /** Full-screen route: stretch the preview to fill the viewport instead of the docked min-height floor. */
  fill?: boolean
}) {
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<PickedElement | null>(null)
  const [draft, setDraft] = useState("")
  const [posting, setPosting] = useState(false)
  const [postError, setPostError] = useState("")
  const [comments, setComments] = useState<AnchoredComment[] | null>(null)
  const [resolutions, setResolutions] = useState<AnchorResolutionMap>({})
  const [refreshKey, setRefreshKey] = useState(0)

  const load = useCallback(async () => {
    try {
      const query = new URLSearchParams({ targetType: "ARTIFACT", targetId: artifactId })
      const response = await fetch(`/api/comments?${query}`)
      if (!response.ok) return
      const data = (await response.json()) as { items?: AnchoredComment[] }
      setComments((data.items ?? []).filter((item) => item.elementAnchor))
    } catch {
      // A failed pin refresh leaves stale/no pins; it is not a broken viewer.
    }
  }, [artifactId])

  useEffect(() => {
    void load()
    // refreshKey is bumped after a successful post so the new pin appears
    // without a full page reload.
  }, [load, refreshKey])

  const anchorsToResolve: AnchorRequest[] | undefined = comments?.map((comment) => ({
    commentId: comment.id,
    elementSelector: comment.elementAnchor?.elementSelector ?? null,
    elementFingerprint: (comment.elementAnchor?.elementFingerprint as ElementFingerprint | null) ?? null,
  }))

  const startPicking = () => {
    setPicked(null)
    setPostError("")
    setPicking(true)
  }
  const cancelPicking = () => setPicking(false)
  const cancelDraft = () => {
    setPicked(null)
    setDraft("")
    setPostError("")
  }

  const submit = async () => {
    if (!picked || !draft.trim()) return
    setPosting(true)
    setPostError("")
    try {
      const response = await fetch("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetType: "ARTIFACT",
          targetId: artifactId,
          body: draft,
          elementAnchor: {
            pageUrl: window.location.href,
            pagePath: window.location.pathname,
            elementSelector: picked.selector,
            elementFingerprint: picked.fingerprint,
          },
        }),
      })
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null)
        const message = typeof payload === "object" && payload && "error" in payload && typeof payload.error === "string" ? payload.error : "The comment could not be posted."
        throw new Error(message)
      }
      setPicked(null)
      setDraft("")
      setRefreshKey((value) => value + 1)
      onFeedbackPosted?.()
    } catch (error) {
      setPostError(error instanceof Error ? error.message : "The comment could not be posted.")
    } finally {
      setPosting(false)
    }
  }

  const staleCount = Object.values(resolutions).filter((resolution) => resolution.status === "stale").length

  return (
    <div className={`space-y-3 ${fill ? "flex h-full min-h-0 flex-col" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant={picking ? "default" : "outline"}
          size="sm"
          aria-pressed={picking}
          onClick={() => (picking ? cancelPicking() : startPicking())}
        >
          <MessageSquarePlus aria-hidden />
          {picking ? "Cancel picking" : "Leave feedback"}
        </Button>
        {fullScreenHref && (
          <Link href={fullScreenHref} className={buttonVariants({ variant: "outline", size: "sm" })}>
            <Maximize2 aria-hidden />
            View full screen
          </Link>
        )}
        {backHref && (
          <Link href={backHref} className={buttonVariants({ variant: "outline", size: "sm" })}>
            <ArrowLeft aria-hidden />
            Back to artifact
          </Link>
        )}
      </div>
      {picking && (
        <p role="status" className="text-xs text-text-subtle">
          Click an element in the preview to attach feedback to it. Press Escape to cancel.
        </p>
      )}
      {staleCount > 0 && (
        <p role="status" className="text-xs text-status-warning">
          {staleCount} pinned comment{staleCount === 1 ? "" : "s"} could not be re-anchored precisely and may have moved.
        </p>
      )}
      <div className={fill ? "min-h-0 flex-1" : ""}>
        <ArtifactPreview
          title={title}
          html={html}
          externalUrl={externalUrl}
          fill={fill}
          pickMode={picking}
          onElementPicked={(element) => {
            setPicked(element)
            setPicking(false)
          }}
          onPickModeExited={() => setPicking(false)}
          anchorsToResolve={anchorsToResolve}
          onAnchorsResolved={(next) => setResolutions((current) => ({ ...current, ...next }))}
          resolutions={resolutions}
          renderPin={(commentId, resolution) => {
            const comment = comments?.find((item) => item.id === commentId)
            return (
              <button
                type="button"
                aria-label={comment ? `Feedback from ${comment.authorName}: ${comment.body.slice(0, 80)}` : "Feedback pin"}
                title={comment?.body}
                className="flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-primary text-[11px] font-semibold text-primary-foreground shadow-md"
                style={{ opacity: resolution.confidence < 1 ? 0.85 : 1 }}
              >
                !
              </button>
            )
          }}
        />
      </div>
      {picked && (
        <form
          className="space-y-2 rounded-lg border border-border-default p-3"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <p className="text-xs text-text-subtle">
            Commenting on: {picked.fingerprint.tag ?? "element"}
            {picked.fingerprint.text ? ` "${picked.fingerprint.text}"` : ""}
          </p>
          <Textarea
            autoFocus
            aria-label="Anchored feedback"
            placeholder="What should change here?"
            value={draft}
            disabled={posting}
            onChange={(event) => setDraft(event.target.value)}
          />
          {postError && <p role="alert" className="text-xs text-status-danger">{postError}</p>}
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={posting || !draft.trim()}>
              {posting ? "Posting…" : "Post feedback"}
            </Button>
            <Button size="sm" type="button" variant="ghost" onClick={cancelDraft}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
