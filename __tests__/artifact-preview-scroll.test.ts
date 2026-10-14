// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { ARTIFACT_PICK_MESSAGE_TYPES, ARTIFACT_PREVIEW_MESSAGE_SCOPE, injectArtifactPreviewHandshake } from "@/lib/artifact-preview-html"

/**
 * Runs the sandbox bootstrap script (the part of injectArtifactPreviewHandshake
 * that executes inside the iframe) against a fake window and the real jsdom
 * document, so the anchor re-report behavior is exercised as code rather than
 * only as a string.
 */
const TOKEN = "t".repeat(64)

function bootSandbox() {
  const html = injectArtifactPreviewHandshake("<html><body></body></html>", TOKEN)
  const body = /<script>([\s\S]*)<\/script>/.exec(html)![1]
  const listeners: Record<string, Array<(event: unknown) => void>> = {}
  const parent = { postMessage: vi.fn() }
  const fakeWindow = {
    parent,
    scrollX: 0,
    scrollY: 0,
    addEventListener: (type: string, fn: (event: unknown) => void) => { (listeners[type] ??= []).push(fn) },
  }
  const frames: Array<() => void> = []
  new Function("window", "requestAnimationFrame", body)(fakeWindow, (fn: () => void) => frames.push(fn))
  const fire = (type: string, event: unknown = {}) => (listeners[type] ?? []).forEach((fn) => fn(event))
  const flushFrames = () => frames.splice(0).forEach((fn) => fn())
  const resultsSent = () =>
    parent.postMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === ARTIFACT_PICK_MESSAGE_TYPES.ANCHOR_RESULTS)
  return { parent, fire, flushFrames, resultsSent }
}

function placeButton(top: number) {
  const button = document.createElement("button")
  button.id = "cta"
  button.textContent = "Buy now"
  document.body.appendChild(button)
  const state = { top }
  button.getBoundingClientRect = () => ({ left: 5, top: state.top, width: 40, height: 20, right: 45, bottom: state.top + 20, x: 5, y: state.top, toJSON: () => ({}) })
  return state
}

afterEach(() => { document.body.innerHTML = "" })

it("re-reports an anchor's geometry when the document scrolls, without re-resolving from scratch", () => {
  const button = placeButton(300)
  const { parent, fire, flushFrames, resultsSent } = bootSandbox()

  fire("message", {
    source: parent,
    data: {
      scope: ARTIFACT_PREVIEW_MESSAGE_SCOPE,
      token: TOKEN,
      type: ARTIFACT_PICK_MESSAGE_TYPES.RESOLVE_ANCHORS,
      anchors: [{ commentId: "c1", elementSelector: "#cta", elementFingerprint: { tag: "button" } }],
    },
  })
  expect(resultsSent()).toHaveLength(1)
  expect(resultsSent()[0].results[0]).toMatchObject({ commentId: "c1", matched: true, geometry: { top: 300 } })

  // The page scrolls 120px: the element moves up in the viewport.
  button.top = 180
  fire("scroll")
  fire("scroll") // a burst of scroll events coalesces into one frame
  flushFrames()

  expect(resultsSent()).toHaveLength(2)
  expect(resultsSent()[1].results[0]).toMatchObject({ commentId: "c1", matched: true, geometry: { top: 180 } })
})

it("keeps fingerprint candidates following a scroll when the selector no longer matches", () => {
  const button = placeButton(300)
  const { parent, fire, flushFrames, resultsSent } = bootSandbox()

  fire("message", {
    source: parent,
    data: {
      scope: ARTIFACT_PREVIEW_MESSAGE_SCOPE,
      token: TOKEN,
      type: ARTIFACT_PICK_MESSAGE_TYPES.RESOLVE_ANCHORS,
      anchors: [{ commentId: "c1", elementSelector: "#gone", elementFingerprint: { tag: "button", text: "Buy now" } }],
    },
  })
  expect(resultsSent()[0].results[0]).toMatchObject({ matched: false, candidates: [{ geometry: { top: 300 } }] })

  button.top = 100
  fire("scroll")
  flushFrames()

  const latest = resultsSent().at(-1)!.results[0]
  expect(latest).toMatchObject({ matched: false, candidates: [{ geometry: { top: 100 } }] })
  // Document-relative ratios are scroll-invariant, so they come from the cached fingerprint.
  expect(latest.candidates[0].fingerprint.tag).toBe("button")
})

it("does nothing on scroll before any anchors have been requested", () => {
  const { fire, flushFrames, resultsSent } = bootSandbox()
  fire("scroll")
  flushFrames()
  expect(resultsSent()).toHaveLength(0)
})
