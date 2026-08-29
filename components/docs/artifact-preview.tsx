"use client"

import { ExternalLink } from "lucide-react"
import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { ARTIFACT_PREVIEW_MESSAGE_SCOPE, injectArtifactPreviewHandshake } from "@/lib/artifact-preview-html"

export const ARTIFACT_IFRAME_SANDBOX = "allow-scripts" as const
export { ARTIFACT_PREVIEW_MESSAGE_SCOPE }
export const ARTIFACT_PREVIEW_READY_TIMEOUT_MS = 4_000

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
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<"loading" | "ready" | "navigating" | "timeout">("loading")
  const token = useMemo(() => {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  }, [attempt])

  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    let ready = false
    const disableFrame = () => {
      frame.style.display = "none"
      frame.srcdoc = "<!doctype html>"
    }
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return
      const message = event.data as { scope?: unknown; token?: unknown; state?: unknown } | null
      if (!message || message.scope !== ARTIFACT_PREVIEW_MESSAGE_SCOPE || message.token !== token) return
      if (message.state === "NAVIGATING") {
        disableFrame()
        setState("navigating")
      } else if (message.state === "READY") {
        ready = true
        setState("ready")
      }
    }
    window.addEventListener("message", onMessage)
    const timeout = window.setTimeout(() => {
      if (ready) return
      disableFrame()
      setState("timeout")
    }, ARTIFACT_PREVIEW_READY_TIMEOUT_MS)
    // The listener and timeout are active before any uploaded byte is parsed.
    frame.srcdoc = injectArtifactPreviewHandshake(html, token)
    return () => {
      window.removeEventListener("message", onMessage)
      window.clearTimeout(timeout)
    }
  }, [html, token])

  if (state === "navigating" || state === "timeout") {
    return <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <p>{state === "navigating"
        ? "Preview navigation attempt blocked. The uploaded HTML was removed from the frame."
        : "Preview could not start safely because its trusted readiness check did not complete."}</p>
      <Button size="sm" variant="outline" className="mt-3" onClick={() => {
        setState("loading")
        setAttempt((value) => value + 1)
      }}>Reload preview</Button>
    </div>
  }

  return <div className="relative min-h-[520px]">
    {state === "loading" && <div role="status" className="absolute inset-0 grid place-items-center rounded-lg border border-slate-200 bg-slate-50 text-sm text-slate-500">Loading preview…</div>}
    <iframe
      ref={frameRef}
      title={`${title} preview`}
      sandbox={ARTIFACT_IFRAME_SANDBOX}
      referrerPolicy="no-referrer"
      className={`w-full min-h-[520px] rounded-lg border border-slate-200 bg-white transition-opacity ${state === "ready" ? "opacity-100" : "pointer-events-none opacity-0"}`}
    />
  </div>
}
