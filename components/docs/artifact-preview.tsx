"use client"

import { ExternalLink } from "lucide-react"
import { ARTIFACT_IFRAME_SANDBOX, ARTIFACT_PREVIEW_MESSAGE_SCOPE, ARTIFACT_PREVIEW_READY_TIMEOUT_MS, ArtifactSandboxedFrame } from "@/components/artifact-sandboxed-frame"

export { ARTIFACT_IFRAME_SANDBOX, ARTIFACT_PREVIEW_MESSAGE_SCOPE, ARTIFACT_PREVIEW_READY_TIMEOUT_MS }

export function ArtifactPreview({ title, html, externalUrl }: { title: string; html?: string; externalUrl?: string | null }) {
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
  return <ArtifactSandboxedFrame key={html} title={title} html={html} />
}
