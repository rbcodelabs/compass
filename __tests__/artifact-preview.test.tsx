// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ArtifactPreview, ARTIFACT_IFRAME_SANDBOX, ARTIFACT_PREVIEW_MESSAGE_SCOPE, ARTIFACT_PREVIEW_READY_TIMEOUT_MS } from "@/components/docs/artifact-preview"

function handshake(frame: HTMLIFrameElement) {
  const token = frame.srcdoc.match(/const token=("[a-f0-9]+")/)?.[1]
  if (!token) throw new Error("trusted preview token was not injected")
  return JSON.parse(token) as string
}

function post(frame: HTMLIFrameElement, token: string, state: "READY" | "NAVIGATING", source: MessageEventSource | null = frame.contentWindow) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", {
      data: { scope: ARTIFACT_PREVIEW_MESSAGE_SCOPE, token, state },
      source,
    }))
  })
}

function postTyped(frame: HTMLIFrameElement, token: string, payload: Record<string, unknown>, source: MessageEventSource | null = frame.contentWindow) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", {
      data: { scope: ARTIFACT_PREVIEW_MESSAGE_SCOPE, token, ...payload },
      source,
    }))
  })
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("ArtifactPreview", () => {
  it("uses the exact approved hostile-HTML sandbox and grants no iframe permissions", () => {
    render(<ArtifactPreview title="Prototype" html="<html><body>Hi</body></html>" />)
    const frame = screen.getByTitle("Prototype preview") as HTMLIFrameElement
    expect(ARTIFACT_IFRAME_SANDBOX).toBe("allow-scripts")
    expect(frame).toHaveAttribute("sandbox", "allow-scripts")
    expect(frame).not.toHaveAttribute("allow")
    expect(frame.getAttribute("sandbox")).not.toMatch(/same-origin|forms|popups|downloads|top-navigation/)
    expect(frame.srcdoc).toMatch(/^<meta http-equiv="Content-Security-Policy"/)
    expect(frame.srcdoc.indexOf("document.currentScript")).toBeLessThan(frame.srcdoc.indexOf("<html><body>Hi"))
    expect(frame.srcdoc).toContain("own.remove()")
  })

  it("opens external artifacts in a noopener noreferrer tab", () => {
    render(<ArtifactPreview title="External" externalUrl="https://example.com/prototype" />)
    const link = screen.getByRole("link", { name: /open external artifact/i })
    expect(link).toHaveAttribute("rel", "noopener noreferrer")
    expect(link).toHaveAttribute("target", "_blank")
  })

  it("shows the iframe only after an authenticated readiness handshake", () => {
    const view = render(<ArtifactPreview title="Navigation Prototype" html="<html><a href='data:text/html,phish'>Go</a></html>" />)
    const frame = view.getByTitle("Navigation Prototype preview") as HTMLIFrameElement
    expect(screen.getByRole("status")).toHaveTextContent(/loading preview/i)
    post(frame, handshake(frame), "READY")
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    expect(frame).toHaveClass("opacity-100")
  })

  it("removes the iframe on an authenticated navigation signal", () => {
    const view = render(<ArtifactPreview title="Navigation Prototype" html="<html><a href='data:text/html,phish'>Go</a></html>" />)
    const frame = view.getByTitle("Navigation Prototype preview") as HTMLIFrameElement
    const token = handshake(frame)
    post(frame, token, "READY")
    post(frame, token, "NAVIGATING")
    expect(view.queryByTitle("Navigation Prototype preview")).not.toBeInTheDocument()
    expect(view.getByRole("alert")).toHaveTextContent(/navigation attempt blocked/i)
  })

  it("ignores preview messages with the wrong token or source", () => {
    const view = render(<ArtifactPreview title="Prototype" html="<html><body>Hi</body></html>" />)
    const frame = view.getByTitle("Prototype preview") as HTMLIFrameElement
    const token = handshake(frame)
    post(frame, `${token}00`, "NAVIGATING")
    post(frame, token, "NAVIGATING", null)
    expect(view.getByTitle("Prototype preview")).toBeInTheDocument()
    expect(view.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("removes an iframe that never completes the trusted handshake", () => {
    vi.useFakeTimers()
    const view = render(<ArtifactPreview title="Stalled Prototype" html="<html><body>Hi</body></html>" />)
    expect(view.getByTitle("Stalled Prototype preview")).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(ARTIFACT_PREVIEW_READY_TIMEOUT_MS))
    expect(view.queryByTitle("Stalled Prototype preview")).not.toBeInTheDocument()
    expect(view.getByRole("alert")).toHaveTextContent(/could not start safely/i)
  })
})

describe("ArtifactPreview element picking and anchor pins", () => {
  it("only enters pick mode once the handshake is ready, and exits when the prop goes false", () => {
    const view = render(<ArtifactPreview title="Prototype" html="<html><body>Hi</body></html>" pickMode />)
    const frame = view.getByTitle("Prototype preview") as HTMLIFrameElement
    const token = handshake(frame)
    const postSpy = vi.spyOn(frame.contentWindow!, "postMessage")
    // Not yet ready: sending now would be a no-op the sandbox's listener isn't
    // installed to receive, so the effect must wait for READY rather than race it.
    expect(postSpy).not.toHaveBeenCalled()
    post(frame, token, "READY")
    expect(postSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "ENTER_PICK_MODE" }), "*")

    postSpy.mockClear()
    view.rerender(<ArtifactPreview title="Prototype" html="<html><body>Hi</body></html>" pickMode={false} />)
    expect(postSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "EXIT_PICK_MODE" }), "*")
  })

  it("reports a picked element's selector and fingerprint, never credentials", () => {
    const onElementPicked = vi.fn()
    const view = render(<ArtifactPreview title="Prototype" html="<html><body>Hi</body></html>" pickMode onElementPicked={onElementPicked} />)
    const frame = view.getByTitle("Prototype preview") as HTMLIFrameElement
    const token = handshake(frame)
    post(frame, token, "READY")
    postTyped(frame, token, { type: "ELEMENT_PICKED", selector: "button.cta", fingerprint: { tag: "button", text: "Buy now", rectXRatio: 0.2, rectYRatio: 0.3 } })
    expect(onElementPicked).toHaveBeenCalledWith({ selector: "button.cta", fingerprint: { tag: "button", text: "Buy now", rectXRatio: 0.2, rectYRatio: 0.3 } })
  })

  it("calls onPickModeExited when the sandbox exits on its own (Escape)", () => {
    const onPickModeExited = vi.fn()
    const view = render(<ArtifactPreview title="Prototype" html="<html><body>Hi</body></html>" pickMode onPickModeExited={onPickModeExited} />)
    const frame = view.getByTitle("Prototype preview") as HTMLIFrameElement
    const token = handshake(frame)
    post(frame, token, "READY")
    postTyped(frame, token, { type: "PICK_MODE_EXITED" })
    expect(onPickModeExited).toHaveBeenCalledTimes(1)
  })

  it("resolves a matched selector anchor as anchored and renders it via renderPin", () => {
    const onAnchorsResolved = vi.fn()
    const view = render(
      <ArtifactPreview
        title="Prototype"
        html="<html><body>Hi</body></html>"
        anchorsToResolve={[{ commentId: "c1", elementSelector: "#cta", elementFingerprint: { tag: "button" } }]}
        onAnchorsResolved={onAnchorsResolved}
        resolutions={{}}
        renderPin={(commentId) => <span data-testid={`pin-${commentId}`}>pin</span>}
      />,
    )
    const frame = view.getByTitle("Prototype preview") as HTMLIFrameElement
    const token = handshake(frame)
    post(frame, token, "READY")
    postTyped(frame, token, { type: "ANCHOR_RESULTS", results: [{ commentId: "c1", matched: true, geometry: { left: 10, top: 20, width: 30, height: 40 } }] })
    expect(onAnchorsResolved).toHaveBeenCalledWith({ c1: { status: "anchored", source: "selector", confidence: 1, geometry: { left: 10, top: 20, width: 30, height: 40 } } })
  })

  it("degrades an unmatched anchor with no good candidate to stale, without a pin", () => {
    const onAnchorsResolved = vi.fn()
    const view = render(
      <ArtifactPreview
        title="Prototype"
        html="<html><body>Hi</body></html>"
        anchorsToResolve={[{ commentId: "c1", elementSelector: null, elementFingerprint: { tag: "button", text: "Buy now", rectXRatio: 0.2, rectYRatio: 0.3 } }]}
        onAnchorsResolved={onAnchorsResolved}
      />,
    )
    const frame = view.getByTitle("Prototype preview") as HTMLIFrameElement
    const token = handshake(frame)
    post(frame, token, "READY")
    postTyped(frame, token, {
      type: "ANCHOR_RESULTS",
      results: [{ commentId: "c1", matched: false, candidates: [{ fingerprint: { tag: "a", text: "Unrelated", rectXRatio: 0.95, rectYRatio: 0.95 }, geometry: { left: 1, top: 1, width: 1, height: 1 } }] }],
    })
    expect(onAnchorsResolved).toHaveBeenCalledWith({ c1: { status: "stale" } })
  })

  it("renders a pin only for an anchored resolution, positioned from its geometry", () => {
    const view = render(
      <ArtifactPreview
        title="Prototype"
        html="<html><body>Hi</body></html>"
        resolutions={{
          anchored: { status: "anchored", source: "selector", confidence: 1, geometry: { left: 10, top: 20, width: 30, height: 40 } },
          stale: { status: "stale" },
        }}
        renderPin={(commentId) => <span data-testid={`pin-${commentId}`}>pin</span>}
      />,
    )
    const frame = view.getByTitle("Prototype preview") as HTMLIFrameElement
    post(frame, handshake(frame), "READY")
    expect(view.getByTestId("pin-anchored")).toBeInTheDocument()
    expect(view.queryByTestId("pin-stale")).not.toBeInTheDocument()
    expect(view.getByTestId("pin-anchored").parentElement).toHaveStyle({ left: "10px", top: "20px" })
  })
})
