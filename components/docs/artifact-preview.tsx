"use client"

import { useEffect, useState } from "react"
import { ExternalLink } from "lucide-react"
import {
  ARTIFACT_IFRAME_SANDBOX,
  ARTIFACT_PREVIEW_MESSAGE_SCOPE,
  ARTIFACT_PREVIEW_READY_TIMEOUT_MS,
  ArtifactSandboxedFrame,
  type AnchorRequest,
  type AnchorResolutionMap,
  type PickedElement,
} from "@/components/artifact-sandboxed-frame"
import type { AnchorResolution } from "@/lib/artifact-anchor-match"
import type { ArtifactThumbnailDto } from "@/lib/artifacts"
import type { ReactNode } from "react"

export { ARTIFACT_IFRAME_SANDBOX, ARTIFACT_PREVIEW_MESSAGE_SCOPE, ARTIFACT_PREVIEW_READY_TIMEOUT_MS }
export type { AnchorRequest, AnchorResolutionMap, PickedElement }

type AnchoredResolution = Extract<AnchorResolution, { status: "anchored" }>

export function ArtifactPreview({
  title,
  html,
  externalUrl,
  thumbnail,
  pickMode,
  onElementPicked,
  onPickModeExited,
  anchorsToResolve,
  onAnchorsResolved,
  resolutions,
  renderPin,
  fill,
  holdPrevious = false,
}: {
  title: string
  html?: string
  externalUrl?: string | null
  /** A captured screenshot of the external page, when one exists (capture_screenshot). */
  thumbnail?: ArtifactThumbnailDto | null
  pickMode?: boolean
  onElementPicked?: (picked: PickedElement) => void
  onPickModeExited?: () => void
  anchorsToResolve?: AnchorRequest[]
  onAnchorsResolved?: (resolutions: AnchorResolutionMap) => void
  resolutions?: AnchorResolutionMap
  renderPin?: (commentId: string, resolution: AnchoredResolution) => ReactNode
  fill?: boolean
  /** Keep the previous HTML on screen until the new one has loaded and fitted (slide decks), instead of blanking between. */
  holdPrevious?: boolean
}) {
  if (externalUrl) {
    return <div className="rounded-lg border border-border-default bg-surface-panel p-4 text-center sm:p-8">
      {thumbnail && <a href={externalUrl} target="_blank" rel="noopener noreferrer" className="mb-4 block overflow-hidden rounded-md border border-border-default bg-surface-base">
        {/* A plain <img>, not next/image: the source is an authenticated, no-store
            route, which the image optimizer would fetch without the reader's
            session and cache across readers. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={thumbnail.src}
          width={thumbnail.width}
          height={thumbnail.height}
          alt={`Screenshot of ${title}`}
          loading="lazy"
          className="block h-auto w-full"
        />
      </a>}
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-text-subtle">External</div>
      <a href={externalUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-primary hover:text-primary/80 font-medium">
        Open external artifact <ExternalLink className="size-4" />
      </a>
      <p className="mt-2 text-xs text-text-subtle break-all">{externalUrl}</p>
      {thumbnail && <p className="mt-1 text-xs text-text-disabled">Screenshot captured <time dateTime={thumbnail.capturedAt}>{new Date(thumbnail.capturedAt).toLocaleString()}</time></p>}
    </div>
  }
  if (!html) return <p className="text-sm text-text-subtle">Preview content is unavailable.</p>
  return <ArtifactFrameStack
    title={title}
    html={html}
    holdPrevious={holdPrevious}
    pickMode={pickMode}
    onElementPicked={onElementPicked}
    onPickModeExited={onPickModeExited}
    anchorsToResolve={anchorsToResolve}
    onAnchorsResolved={onAnchorsResolved}
    resolutions={resolutions}
    renderPin={renderPin}
    fill={fill}
  />
}

/** Longest a superseded frame stays underneath if the new one never reports settled, in ms. */
const PREVIOUS_FRAME_MAX_MS = ARTIFACT_PREVIEW_READY_TIMEOUT_MS + 2_500

type StackedFrame = { id: number; html: string }

/**
 * Renders the sandboxed frame for `html`. Switching `html` remounts a fresh
 * frame (a new document, a new handshake). With `holdPrevious` the old frame
 * stays mounted underneath, inert, until the new one reports its slide fit
 * settled, so stepping between slides never shows a blank or black frame while
 * the next slide loads and is hidden awaiting its fit.
 */
function ArtifactFrameStack({ html, holdPrevious, ...frameProps }: {
  title: string
  html: string
  holdPrevious: boolean
  pickMode?: boolean
  onElementPicked?: (picked: PickedElement) => void
  onPickModeExited?: () => void
  anchorsToResolve?: AnchorRequest[]
  onAnchorsResolved?: (resolutions: AnchorResolutionMap) => void
  resolutions?: AnchorResolutionMap
  renderPin?: (commentId: string, resolution: AnchoredResolution) => ReactNode
  fill?: boolean
}) {
  const [frames, setFrames] = useState<StackedFrame[]>(() => [{ id: 0, html }])
  const latest = frames[frames.length - 1]
  if (latest.html !== html) {
    const next = { id: latest.id + 1, html }
    setFrames(holdPrevious ? [...frames, next] : [next])
  }

  const stacked = frames.length > 1
  const latestId = latest.id
  useEffect(() => {
    if (!stacked) return
    const timer = window.setTimeout(() => setFrames((current) => current.filter((frame) => frame.id === latestId)), PREVIOUS_FRAME_MAX_MS)
    return () => window.clearTimeout(timer)
  }, [stacked, latestId])

  const settle = (id: number) => setFrames((current) => (current.some((frame) => frame.id < id) ? current.filter((frame) => frame.id >= id) : current))

  // One uniform list, so a frame keeps its place (and its loaded document)
  // when it stops being the newest; moving an iframe in the tree would reload it.
  return <div className={frameProps.fill ? "relative h-full" : "relative"}>
    {frames.map((frame, index) => {
      const current = index === frames.length - 1
      return <div key={frame.id} aria-hidden={current ? undefined : true} className={current ? (frameProps.fill ? "relative h-full" : "relative") : "pointer-events-none absolute inset-0"}>
        {current
          ? <ArtifactSandboxedFrame {...frameProps} html={frame.html} transparent={stacked} onSettled={() => settle(frame.id)} />
          : <ArtifactSandboxedFrame title={frameProps.title} html={frame.html} fill={frameProps.fill} />}
      </div>
    })}
  </div>
}
