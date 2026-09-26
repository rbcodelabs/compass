"use client"

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
import type { ReactNode } from "react"

export { ARTIFACT_IFRAME_SANDBOX, ARTIFACT_PREVIEW_MESSAGE_SCOPE, ARTIFACT_PREVIEW_READY_TIMEOUT_MS }
export type { AnchorRequest, AnchorResolutionMap, PickedElement }

type AnchoredResolution = Extract<AnchorResolution, { status: "anchored" }>

export function ArtifactPreview({
  title,
  html,
  externalUrl,
  pickMode,
  onElementPicked,
  onPickModeExited,
  anchorsToResolve,
  onAnchorsResolved,
  resolutions,
  renderPin,
  fill,
}: {
  title: string
  html?: string
  externalUrl?: string | null
  pickMode?: boolean
  onElementPicked?: (picked: PickedElement) => void
  onPickModeExited?: () => void
  anchorsToResolve?: AnchorRequest[]
  onAnchorsResolved?: (resolutions: AnchorResolutionMap) => void
  resolutions?: AnchorResolutionMap
  renderPin?: (commentId: string, resolution: AnchoredResolution) => ReactNode
  fill?: boolean
}) {
  if (externalUrl) {
    return <div className="rounded-lg border border-border-default bg-surface-panel p-8 text-center">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-text-subtle">External</div>
      <a href={externalUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-primary hover:text-primary/80 font-medium">
        Open external artifact <ExternalLink className="size-4" />
      </a>
      <p className="mt-2 text-xs text-text-subtle break-all">{externalUrl}</p>
    </div>
  }
  if (!html) return <p className="text-sm text-text-subtle">Preview content is unavailable.</p>
  return <ArtifactSandboxedFrame
    key={html}
    title={title}
    html={html}
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
