"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { createPortal } from "react-dom"
import { ArrowLeft, ChevronLeft, ChevronRight, Maximize2, MessageSquarePlus, MessageSquareText } from "lucide-react"
import { ArtifactDeckControls, ArtifactSlidePicker } from "./artifact-deck-controls"
import { ArtifactPreview, type AnchorRequest, type AnchorResolutionMap, type PickedElement } from "./artifact-preview"
import { Button, buttonVariants } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { ElementFingerprint } from "@/lib/artifact-anchor-match"
import type { ArtifactThumbnailDto } from "@/lib/artifacts"
// Type-only: lib/artifact-slides is server-only (cheerio) and is erased here.
import type { ArtifactSlideDto } from "@/lib/artifact-slides"

type AnchoredComment = {
  id: string
  authorName: string
  body: string
  elementAnchor?: { elementSelector: string | null; elementFingerprint: unknown; slideIndex?: number | null } | null
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
 *
 * With `slides` (a SLIDE_DECK Artifact) it shows one slide at a time, with
 * prev/next and arrow-key navigation. Feedback posted here carries the current
 * `slideIndex`, pins are filtered to the slide on screen, and "Comment on slide"
 * leaves a whole-slide comment with no element selector.
 */
export function ArtifactViewer({
  title,
  html,
  externalUrl,
  thumbnail,
  artifactId,
  fullScreenHref,
  backHref,
  onFeedbackPosted,
  fill = false,
  slides,
  initialSlideIndex = 0,
  toolbarSlot,
}: {
  title: string
  html?: string
  externalUrl?: string | null
  thumbnail?: ArtifactThumbnailDto | null
  artifactId: string
  /** Present only in the docked view — links out to the full-screen route. */
  fullScreenHref?: string
  /** Present only in the full-screen view — links back to the docked artifact page. */
  backHref?: string
  /** Called after a feedback comment is successfully posted (e.g. to refresh a sibling Discussion panel). */
  onFeedbackPosted?: () => void
  /** Full-screen route: stretch the preview to fill the viewport instead of the docked min-height floor. */
  fill?: boolean
  /** Present only for a SLIDE_DECK Artifact; each slide is already sandboxed. */
  slides?: ArtifactSlideDto[]
  /** Zero-based slide to open on (clamped). */
  initialSlideIndex?: number
  /**
   * Docked view only: render the action toolbar (Leave feedback, View full
   * screen, …) into this element — the page header — instead of above the
   * preview. `undefined` keeps it inline; `null` means the slot has not mounted
   * yet, so nothing renders until it does.
   */
  toolbarSlot?: HTMLElement | null
}) {
  const isDeck = Boolean(slides && slides.length > 0)
  const slideCount = slides?.length ?? 0
  const [slideIndex, setSlideIndex] = useState(() => Math.min(Math.max(0, Math.trunc(initialSlideIndex) || 0), Math.max(0, slideCount - 1)))
  const currentSlide = isDeck ? slides?.[slideIndex] : undefined
  const activeHtml = currentSlide ? currentSlide.html : html
  const [slideWideDraft, setSlideWideDraft] = useState(false)
  const [picking, setPicking] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
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

  // In a deck, only the slide on screen has elements to pin to; a whole-slide
  // comment (no selector) has nothing to resolve and is listed instead.
  const visibleComments = useMemo(() => {
    if (!comments) return comments
    if (!isDeck) return comments
    return comments.filter((comment) => (comment.elementAnchor?.slideIndex ?? 0) === slideIndex)
  }, [comments, isDeck, slideIndex])
  const slideWideComments = isDeck ? (visibleComments ?? []).filter((comment) => !comment.elementAnchor?.elementSelector) : []

  const anchorsToResolve: AnchorRequest[] | undefined = useMemo(() => visibleComments
    ?.filter((comment) => !isDeck || comment.elementAnchor?.elementSelector)
    .map((comment) => ({
      commentId: comment.id,
      elementSelector: comment.elementAnchor?.elementSelector ?? null,
      elementFingerprint: (comment.elementAnchor?.elementFingerprint as ElementFingerprint | null) ?? null,
    })), [visibleComments, isDeck])

  const goToSlide = useCallback((next: number) => {
    if (!isDeck) return
    const clamped = Math.min(Math.max(0, next), slideCount - 1)
    if (clamped === slideIndex) return
    setSlideIndex(clamped)
    // Resolutions are geometry inside the previous slide's frame.
    setResolutions({})
    setPicking(false)
    setPicked(null)
    setSlideWideDraft(false)
    setDraft("")
    setPostError("")
  }, [isDeck, slideCount, slideIndex])

  useEffect(() => {
    if (!isDeck || pickerOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return
      if (event.key === "ArrowRight" || event.key === "PageDown") { event.preventDefault(); goToSlide(slideIndex + 1) }
      else if (event.key === "ArrowLeft" || event.key === "PageUp") { event.preventDefault(); goToSlide(slideIndex - 1) }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [isDeck, pickerOpen, goToSlide, slideIndex])

  const startPicking = () => {
    setPicked(null)
    setSlideWideDraft(false)
    setPostError("")
    setPicking(true)
  }
  const cancelPicking = () => setPicking(false)
  const cancelDraft = () => {
    setPicked(null)
    setSlideWideDraft(false)
    setDraft("")
    setPostError("")
  }

  const submit = async () => {
    if ((!picked && !slideWideDraft) || !draft.trim()) return
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
            elementSelector: picked?.selector ?? null,
            elementFingerprint: picked?.fingerprint ?? null,
            ...(isDeck ? { slideIndex } : {}),
          },
        }),
      })
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null)
        const message = typeof payload === "object" && payload && "error" in payload && typeof payload.error === "string" ? payload.error : "The comment could not be posted."
        throw new Error(message)
      }
      setPicked(null)
      setSlideWideDraft(false)
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

  const previewEl = (
    <ArtifactPreview
      title={title}
      html={activeHtml}
      externalUrl={externalUrl}
      thumbnail={thumbnail}
      fill={fill}
      holdPrevious={isDeck}
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
  )

  const commentsList = slideWideComments.length > 0 && (
    <div className={fill ? "max-h-32 overflow-y-auto border-b border-border-default pb-2 text-xs" : "rounded-lg border border-border-default p-3 text-xs"}>
      <p className="font-medium text-text-primary">
        {slideWideComments.length} comment{slideWideComments.length === 1 ? "" : "s"} on this slide
      </p>
      <ul className="mt-1 space-y-1 text-text-secondary">
        {slideWideComments.map((comment) => (
          <li key={comment.id} className="break-words"><span className="font-medium">{comment.authorName}:</span> {comment.body.length > 140 ? `${comment.body.slice(0, 140)}…` : comment.body}</li>
        ))}
      </ul>
    </div>
  )

  const formEl = (picked || slideWideDraft) && (
    <form
      className={fill ? "space-y-2" : "space-y-2 rounded-lg border border-border-default p-3"}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <p className="text-xs text-text-subtle">
        {picked ? (
          <>
            Commenting on: {picked.fingerprint.tag ?? "element"}
            {picked.fingerprint.text ? ` "${picked.fingerprint.text}"` : ""}
            {isDeck ? ` on slide ${slideIndex + 1}` : ""}
          </>
        ) : (
          <>Commenting on slide {slideIndex + 1}{currentSlide?.title ? ` · ${currentSlide.title}` : ""}</>
        )}
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
  )

  const statusEl = (
    <>
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
    </>
  )

  // Full-screen route: an edge-to-edge preview with everything else floating
  // over it, so nothing but the slide takes up layout space.
  if (fill) {
    const togglePicking = () => (picking ? cancelPicking() : startPicking())
    const toggleSlideComment = () => {
      if (slideWideDraft) { cancelDraft(); return }
      setPicking(false)
      setPicked(null)
      setPostError("")
      setSlideWideDraft(true)
    }
    const hasStatus = picking || staleCount > 0
    return (
      <div className="relative h-full w-full overflow-hidden bg-black">
        <div className="absolute inset-0">{previewEl}</div>
        {hasStatus && (
          <div className="absolute left-1/2 top-4 z-30 max-w-[calc(100%-2rem)] -translate-x-1/2 space-y-1 rounded-full bg-[rgba(0,20,61,0.88)] px-4 py-1.5 shadow-lg backdrop-blur-md [&_p]:text-white/90 [&_p]:text-xs">
            {statusEl}
          </div>
        )}
        {(picked || slideWideDraft) && (
          <div className="absolute bottom-20 left-1/2 z-30 max-h-[70%] w-[min(32rem,calc(100%-2rem))] -translate-x-1/2 space-y-2 overflow-y-auto rounded-xl border border-border-default bg-surface-panel p-3 shadow-xl">
            {slideWideDraft && commentsList}
            {formEl}
          </div>
        )}
        <ArtifactDeckControls
          isDeck={isDeck}
          slideIndex={slideIndex}
          slideCount={slideCount}
          picking={picking}
          onTogglePicking={togglePicking}
          slideCommentOpen={slideWideDraft}
          slideCommentCount={slideWideComments.length}
          onToggleSlideComment={toggleSlideComment}
          onPrev={() => goToSlide(slideIndex - 1)}
          onNext={() => goToSlide(slideIndex + 1)}
          onOpenPicker={() => setPickerOpen(true)}
          backHref={backHref ? (isDeck ? `${backHref}?slide=${slideIndex + 1}` : backHref) : undefined}
        />
        {pickerOpen && slides && (
          <ArtifactSlidePicker
            slides={slides}
            currentIndex={slideIndex}
            onClose={() => setPickerOpen(false)}
            onSelect={(index) => { goToSlide(index); setPickerOpen(false) }}
          />
        )}
      </div>
    )
  }

  // Slotted into the page header, labels collapse to icons when the content
  // column is narrow (aria-label keeps the accessible name). Inline, always show.
  const label = (text: string) => toolbarSlot === undefined ? text : <span className="hidden @2xl:inline">{text}</span>
  const toolbarButtons = (
    <>
      <Button
        type="button"
        variant={picking ? "default" : "outline"}
        size="sm"
        aria-pressed={picking}
        aria-label={picking ? "Cancel picking" : "Leave feedback"}
        title={picking ? "Cancel picking" : "Leave feedback"}
        onClick={() => (picking ? cancelPicking() : startPicking())}
      >
        <MessageSquarePlus aria-hidden />
        {label(picking ? "Cancel picking" : "Leave feedback")}
      </Button>
      {fullScreenHref && (
        <Link href={isDeck ? `${fullScreenHref}?slide=${slideIndex + 1}` : fullScreenHref} aria-label="View full screen" title="View full screen" className={buttonVariants({ variant: "outline", size: "sm" })}>
          <Maximize2 aria-hidden />
          {label("View full screen")}
        </Link>
      )}
      {isDeck && (
        <Button
          type="button"
          variant={slideWideDraft ? "default" : "outline"}
          size="sm"
          aria-label="Comment on slide"
          title="Comment on slide"
          onClick={() => { setPicking(false); setPicked(null); setPostError(""); setSlideWideDraft(true) }}
        >
          <MessageSquareText aria-hidden />
          {label("Comment on slide")}
        </Button>
      )}
      {backHref && (
        <Link href={isDeck ? `${backHref}?slide=${slideIndex + 1}` : backHref} className={buttonVariants({ variant: "outline", size: "sm" })}>
          <ArrowLeft aria-hidden />
          Back to artifact
        </Link>
      )}
    </>
  )

  return (
    <div className="space-y-3">
      {toolbarSlot === undefined ? <div className="flex flex-wrap items-center gap-2">{toolbarButtons}</div> : toolbarSlot && createPortal(toolbarButtons, toolbarSlot)}
      {isDeck && currentSlide && (
        <nav aria-label="Slides" className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" aria-label="Previous slide" disabled={slideIndex === 0} onClick={() => goToSlide(slideIndex - 1)}>
            <ChevronLeft aria-hidden />
          </Button>
          <p aria-live="polite" className="min-w-0 truncate text-sm text-text-secondary">
            <span className="font-medium text-text-primary">Slide {slideIndex + 1} of {slideCount}</span>
            {currentSlide.title ? ` · ${currentSlide.title}` : ""}
          </p>
          <Button type="button" variant="outline" size="sm" aria-label="Next slide" disabled={slideIndex >= slideCount - 1} onClick={() => goToSlide(slideIndex + 1)}>
            <ChevronRight aria-hidden />
          </Button>
        </nav>
      )}
      {statusEl}
      {previewEl}
      {commentsList}
      {formEl}
    </div>
  )
}
