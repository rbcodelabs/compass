"use client"

import { ExternalLink } from "lucide-react"
import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"

export const ARTIFACT_IFRAME_SANDBOX = "allow-scripts" as const

export function ArtifactPreview({ title, html, externalUrl }: { title: string; html?: string; externalUrl?: string | null }) {
  if (externalUrl) {
    return <div className="rounded-lg border border-slate-200 bg-white p-8 text-center">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">External</div>
      <a href={externalUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-indigo-600 hover:text-indigo-800 font-medium">
        Open external artifact <ExternalLink className="size-4" />
      </a>
      <p className="mt-2 text-xs text-slate-500 break-all">{externalUrl}</p>
    </div>
  }
  if (!html) return <p className="text-sm text-slate-500">Preview content is unavailable.</p>
  return <GuardedArtifactFrame key={html} title={title} html={html} />
}

function GuardedArtifactFrame({ title, html }: { title: string; html: string }) {
  const initialLoadSeen = useRef(false)
  const [navigationBlocked, setNavigationBlocked] = useState(false)

  if (navigationBlocked) {
    return <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <p>Preview navigation attempt blocked. The uploaded HTML was removed from the frame.</p>
      <Button size="sm" variant="outline" className="mt-3" onClick={() => {
        initialLoadSeen.current = false
        setNavigationBlocked(false)
      }}>Reload preview</Button>
    </div>
  }

  return <iframe
    title={`${title} preview`}
    sandbox={ARTIFACT_IFRAME_SANDBOX}
    referrerPolicy="no-referrer"
    srcDoc={html}
    onLoad={() => {
      if (initialLoadSeen.current) setNavigationBlocked(true)
      else initialLoadSeen.current = true
    }}
    className="w-full min-h-[520px] rounded-lg border border-slate-200 bg-white"
  />
}
