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
