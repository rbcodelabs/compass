"use client"

import { useEffect, useSyncExternalStore, type ReactNode } from "react"
import Link from "next/link"
import { ArrowLeft, ChevronLeft, ChevronRight, LayoutGrid, Maximize, Minimize, MessageSquarePlus, MessageSquareText, X } from "lucide-react"

/**
 * The floating controller for the full-screen artifact view: a dark, blurred
 * pill pinned to the bottom-centre over an edge-to-edge preview, in the style of
 * the Commenter deck viewer. Presentational only — ArtifactViewer owns state.
 */

function subscribeFullscreen(callback: () => void) {
  document.addEventListener("fullscreenchange", callback)
  return () => document.removeEventListener("fullscreenchange", callback)
}

function useBrowserFullscreen() {
  const supported = useSyncExternalStore(() => () => {}, () => Boolean(document.fullscreenEnabled), () => false)
  const active = useSyncExternalStore(subscribeFullscreen, () => Boolean(document.fullscreenElement), () => false)
  const toggle = () => {
    const request = active ? document.exitFullscreen() : document.documentElement.requestFullscreen()
    // Denied or interrupted fullscreen is not an error worth surfacing.
    void request.catch(() => {})
  }
  return { supported, active, toggle }
}

const segment =
  "inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-white/90 transition-colors hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:pointer-events-none disabled:opacity-40 aria-pressed:bg-white/25 motion-reduce:transition-none"

function Label({ children }: { children: ReactNode }) {
  return <span className="hidden sm:inline">{children}</span>
}

export function ArtifactDeckControls({
  slideIndex,
  slideCount,
  isDeck,
  picking,
  onTogglePicking,
  slideCommentOpen,
  slideCommentCount,
  onToggleSlideComment,
  onPrev,
  onNext,
  onOpenPicker,
  backHref,
}: {
  slideIndex: number
  slideCount: number
  isDeck: boolean
  picking: boolean
  onTogglePicking: () => void
  slideCommentOpen: boolean
  slideCommentCount: number
  onToggleSlideComment: () => void
  onPrev: () => void
  onNext: () => void
  onOpenPicker: () => void
  backHref?: string
}) {
  const fullscreen = useBrowserFullscreen()
  return (
    <nav
      aria-label="Artifact controls"
      className="absolute bottom-4 left-1/2 z-30 flex max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-0.5 rounded-full bg-[rgba(0,20,61,0.88)] p-1 shadow-[0_4px_16px_rgba(0,0,0,0.24)] backdrop-blur-md print:hidden"
    >
      {isDeck && (
        <>
          <button type="button" className={segment} aria-label="Previous slide" disabled={slideIndex === 0} onClick={onPrev}>
            <ChevronLeft className="size-4" aria-hidden />
            <Label>Prev</Label>
          </button>
          <span aria-live="polite" className="min-w-14 px-1 text-center text-sm tabular-nums text-white">
            {slideIndex + 1} / {slideCount}
          </span>
          <button type="button" className={segment} aria-label="Next slide" disabled={slideIndex >= slideCount - 1} onClick={onNext}>
            <Label>Next</Label>
            <ChevronRight className="size-4" aria-hidden />
          </button>
          <span aria-hidden className="mx-1 h-5 w-px bg-white/25" />
        </>
      )}
      <button type="button" className={segment} aria-pressed={picking} aria-label={picking ? "Cancel picking" : "Leave feedback"} onClick={onTogglePicking}>
        <MessageSquarePlus className="size-4" aria-hidden />
        <Label>{picking ? "Cancel" : "Feedback"}</Label>
      </button>
      {isDeck && (
        <button type="button" className={segment} aria-pressed={slideCommentOpen} aria-label="Comment on slide" onClick={onToggleSlideComment}>
          <MessageSquareText className="size-4" aria-hidden />
          <Label>Comments</Label>
          {slideCommentCount > 0 && (
            <span aria-label={`${slideCommentCount} on this slide`} className="grid min-w-5 place-items-center rounded-full bg-white px-1 text-[11px] font-semibold leading-5 text-[#00143d]">
              {slideCommentCount}
            </span>
          )}
        </button>
      )}
      {isDeck && (
        <button type="button" className={segment} aria-label="All slides" onClick={onOpenPicker}>
          <LayoutGrid className="size-4" aria-hidden />
          <Label>All slides</Label>
        </button>
      )}
      {(fullscreen.supported || backHref) && <span aria-hidden className="mx-1 h-5 w-px bg-white/25" />}
      {fullscreen.supported && (
        <button type="button" className={segment} aria-label={fullscreen.active ? "Exit full screen" : "Enter full screen"} onClick={fullscreen.toggle}>
          {fullscreen.active ? <Minimize className="size-4" aria-hidden /> : <Maximize className="size-4" aria-hidden />}
        </button>
      )}
      {backHref && (
        <Link href={backHref} className={segment} aria-label="Back to artifact">
          <ArrowLeft className="size-4" aria-hidden />
          <Label>Back</Label>
        </Link>
      )}
    </nav>
  )
}

/** "Go to slide" modal: a grid of numbered, titled 16:9 tiles over a blurred backdrop. */
export function ArtifactSlidePicker({
  slides,
  currentIndex,
  onSelect,
  onClose,
}: {
  slides: { title: string | null }[]
  currentIndex: number
  onSelect: (index: number) => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [onClose])

  return (
    <div className="absolute inset-0 z-40 grid place-items-center bg-[rgba(0,10,30,0.55)] p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Go to slide"
        className="flex max-h-full w-full max-w-4xl flex-col rounded-2xl bg-[#00143d] p-4 text-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Go to slide</h2>
          <button type="button" aria-label="Close" className="grid size-8 place-items-center rounded-full hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70" onClick={onClose}>
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <ul className="grid grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3 md:grid-cols-4">
          {slides.map((slide, index) => (
            <li key={index}>
              <button
                type="button"
                autoFocus={index === currentIndex}
                aria-current={index === currentIndex ? "true" : undefined}
                aria-label={`Slide ${index + 1}${slide.title ? `: ${slide.title}` : ""}`}
                className={`flex aspect-video w-full flex-col justify-between rounded-lg bg-white/10 p-2 text-left transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 motion-reduce:transition-none ${index === currentIndex ? "ring-2 ring-white" : ""}`}
                onClick={() => onSelect(index)}
              >
                <span className="text-lg font-semibold tabular-nums text-white/60">{index + 1}</span>
                <span className="line-clamp-2 text-xs font-medium text-white">{slide.title || `Slide ${index + 1}`}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
