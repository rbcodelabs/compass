"use client"

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import {
  ARTIFACT_PICK_MESSAGE_TYPES,
  ARTIFACT_PREVIEW_MESSAGE_SCOPE,
  injectArtifactPreviewHandshake,
} from "@/lib/artifact-preview-html"
import {
  resolveElementAnchor,
  type AnchorResolution,
  type ElementFingerprint,
  type FingerprintCandidate,
  type LiveElementGeometry,
} from "@/lib/artifact-anchor-match"

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
 *
 * ## Element picking and anchor pins
 *
 * The sandbox is an opaque cross-origin frame (no `allow-same-origin`), so
 * neither `window.opener` nor a shared `document` exists between it and this
 * component. The only channel is the scoped, per-mount-tokened `postMessage`
 * handshake already used for READY/NAVIGATING — extended here with a click-
 * picking and anchor-resolution protocol (see the doc comment on
 * `injectArtifactPreviewHandshake`). The sandbox only ever reports element
 * geometry; it never receives or sends credentials, and a pick's click is
 * always swallowed before the uploaded prototype's own handler can fire.
 *
 * Resolved anchor positions are reported as this document's OWN CSS-pixel
 * viewport rect (`LiveElementGeometry`), not the document-relative ratios
 * that get persisted — so a caller-supplied pin can be absolute-positioned
 * directly inside this component's relative wrapper without knowing
 * anything about the sandboxed document's scroll size.
 */
export const ARTIFACT_IFRAME_SANDBOX = "allow-scripts" as const
export { ARTIFACT_PREVIEW_MESSAGE_SCOPE }
export const ARTIFACT_PREVIEW_READY_TIMEOUT_MS = 4_000

export type PickedElement = { selector: string | null; fingerprint: ElementFingerprint }
export type AnchorRequest = { commentId: string; elementSelector: string | null; elementFingerprint: ElementFingerprint | null }
export type AnchorResolutionMap = Record<string, AnchorResolution>
type AnchoredResolution = Extract<AnchorResolution, { status: "anchored" }>

type RawAnchorResult =
  | { commentId: string; matched: true; geometry: LiveElementGeometry }
  | { commentId: string; matched: false; candidates: FingerprintCandidate[] }

function isRawAnchorResult(value: unknown): value is RawAnchorResult {
  return Boolean(value) && typeof value === "object" && "commentId" in (value as object)
}

export function ArtifactSandboxedFrame({
  title,
  html,
  pickMode = false,
  onElementPicked,
  onPickModeExited,
  anchorsToResolve,
  onAnchorsResolved,
  resolutions,
  renderPin,
  fill = false,
}: {
  title: string
  html: string
  /** When true, a click inside the sandbox is captured (never activated) and reported via onElementPicked. */
  pickMode?: boolean
  onElementPicked?: (picked: PickedElement) => void
  /** The sandbox exited pick mode on its own (Escape) rather than via a pick or the pickMode prop going false. */
  onPickModeExited?: () => void
  /** Anchors to re-resolve against the sandbox's current live DOM. Re-sent whenever this array's identity changes. */
  anchorsToResolve?: AnchorRequest[]
  onAnchorsResolved?: (resolutions: AnchorResolutionMap) => void
  /** Anchored-only positions to render as pins, keyed by commentId — typically the caller's own copy of what onAnchorsResolved last reported. */
  resolutions?: AnchorResolutionMap
  renderPin?: (commentId: string, resolution: AnchoredResolution) => ReactNode
  /** Stretch to fill an already-sized ancestor (the full-screen route) instead of the docked view's fixed min-height floor. */
  fill?: boolean
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<"loading" | "ready" | "navigating" | "timeout">("loading")
  const token = useMemo(() => {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  }, [attempt])

  // Read by the message handler below, which is only re-installed when the
  // iframe itself remounts (see the [html, token] effect) — these refs let it
  // see each render's latest callbacks/anchors without that remount.
  const onElementPickedRef = useRef(onElementPicked)
  onElementPickedRef.current = onElementPicked
  const onPickModeExitedRef = useRef(onPickModeExited)
  onPickModeExitedRef.current = onPickModeExited
  const onAnchorsResolvedRef = useRef(onAnchorsResolved)
  onAnchorsResolvedRef.current = onAnchorsResolved
  const anchorsToResolveRef = useRef(anchorsToResolve)
  anchorsToResolveRef.current = anchorsToResolve

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
      const message = event.data as { scope?: unknown; token?: unknown; state?: unknown; type?: unknown } | null
      if (!message || message.scope !== ARTIFACT_PREVIEW_MESSAGE_SCOPE || message.token !== token) return
      if (message.state === "NAVIGATING") {
        disableFrame()
        setState("navigating")
        return
      }
      if (message.state === "READY") {
        ready = true
        setState("ready")
        return
      }
      if (message.type === ARTIFACT_PICK_MESSAGE_TYPES.ELEMENT_PICKED) {
        const selector = typeof (message as { selector?: unknown }).selector === "string" ? (message as { selector: string }).selector : null
        const fingerprint = ((message as { fingerprint?: unknown }).fingerprint ?? {}) as ElementFingerprint
        onElementPickedRef.current?.({ selector, fingerprint })
        return
      }
      if (message.type === ARTIFACT_PICK_MESSAGE_TYPES.PICK_MODE_EXITED) {
        onPickModeExitedRef.current?.()
        return
      }
      if (message.type === ARTIFACT_PICK_MESSAGE_TYPES.ANCHOR_RESULTS) {
        const rawResults = (message as { results?: unknown }).results
        const results = Array.isArray(rawResults) ? rawResults.filter(isRawAnchorResult) : []
        const requestById = new Map((anchorsToResolveRef.current ?? []).map((request) => [request.commentId, request]))
        const resolved: AnchorResolutionMap = {}
        for (const result of results) {
          const request = requestById.get(result.commentId)
          const fingerprint = request?.elementFingerprint ?? null
          resolved[result.commentId] = resolveElementAnchor(
            fingerprint,
            result.matched ? result.geometry : null,
            result.matched ? null : result.candidates,
          )
        }
        onAnchorsResolvedRef.current?.(resolved)
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

  // Pick mode and anchor-resolution requests both need a live contentWindow,
  // which only exists once the handshake has reached READY — sending earlier
  // would silently no-op (postMessage on a window that hasn't installed the
  // listener yet), so both effects wait for it explicitly instead of racing.
  useEffect(() => {
    const contentWindow = frameRef.current?.contentWindow
    if (!contentWindow || state !== "ready") return
    contentWindow.postMessage(
      { scope: ARTIFACT_PREVIEW_MESSAGE_SCOPE, token, type: pickMode ? ARTIFACT_PICK_MESSAGE_TYPES.ENTER_PICK_MODE : ARTIFACT_PICK_MESSAGE_TYPES.EXIT_PICK_MODE },
      "*",
    )
  }, [pickMode, state, token])

  useEffect(() => {
    const contentWindow = frameRef.current?.contentWindow
    if (!contentWindow || state !== "ready" || !anchorsToResolve || anchorsToResolve.length === 0) return
    contentWindow.postMessage(
      { scope: ARTIFACT_PREVIEW_MESSAGE_SCOPE, token, type: ARTIFACT_PICK_MESSAGE_TYPES.RESOLVE_ANCHORS, anchors: anchorsToResolve },
      "*",
    )
  }, [anchorsToResolve, state, token])

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

  const anchoredPins = Object.entries(resolutions ?? {}).filter(
    (entry): entry is [string, AnchoredResolution] => entry[1].status === "anchored",
  )

  return <div className={`relative min-h-[520px] ${fill ? "h-full" : ""}`}>
    {state === "loading" && <div role="status" className="absolute inset-0 grid place-items-center rounded-lg border border-border-default bg-surface-inset text-sm text-text-subtle">Loading preview…</div>}
    <iframe
      ref={frameRef}
      title={`${title} preview`}
      sandbox={ARTIFACT_IFRAME_SANDBOX}
      referrerPolicy="no-referrer"
      className={`w-full min-h-[520px] rounded-lg border border-border-default bg-surface-panel transition-opacity ${fill ? "h-full" : ""} ${state === "ready" ? "opacity-100" : "pointer-events-none opacity-0"}`}
    />
    {state === "ready" && renderPin && anchoredPins.map(([commentId, resolution]) => (
      <div
        key={commentId}
        className="absolute z-10"
        style={{ left: resolution.geometry.left, top: resolution.geometry.top }}
      >
        {renderPin(commentId, resolution)}
      </div>
    ))}
  </div>
}
