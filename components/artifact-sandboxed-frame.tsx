"use client"

import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { ARTIFACT_PREVIEW_MESSAGE_SCOPE, injectArtifactPreviewHandshake } from "@/lib/artifact-preview-html"

/**
 * Shared sandboxing mechanics for rendering untrusted, already-CSP-wrapped
 * Artifact HTML (see lib/artifact-preview-html.ts's buildSandboxedHtml) in an
 * iframe via srcdoc, with an authenticated readiness handshake that detects
 * and kills a top-level navigation attempt before it can phish anyone.
 *
 * Two callers share this: the workspace-member docs artifact viewer
 * (components/docs/artifact-preview.tsx) and the unauthenticated research
 * participant experience (components/research/research-experience.tsx). The
 * audience differs — an external, unauthenticated participant is *more*
 * exposed than a workspace member — so both get the identical mechanism
 * rather than a weaker bespoke one for either caller.
 */
export const ARTIFACT_IFRAME_SANDBOX = "allow-scripts" as const
export { ARTIFACT_PREVIEW_MESSAGE_SCOPE }
export const ARTIFACT_PREVIEW_READY_TIMEOUT_MS = 4_000

export function ArtifactSandboxedFrame({ title, html }: { title: string; html: string }) {
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
    return <div role="alert" className="rounded-lg border border-status-warning bg-status-warning-surface p-4 text-sm text-status-warning">
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
    {state === "loading" && <div role="status" className="absolute inset-0 grid place-items-center rounded-lg border border-border-default bg-surface-inset text-sm text-text-subtle">Loading preview…</div>}
    <iframe
      ref={frameRef}
      title={`${title} preview`}
      sandbox={ARTIFACT_IFRAME_SANDBOX}
      referrerPolicy="no-referrer"
      className={`w-full min-h-[520px] rounded-lg border border-border-default bg-surface-panel transition-opacity ${state === "ready" ? "opacity-100" : "pointer-events-none opacity-0"}`}
    />
  </div>
}
