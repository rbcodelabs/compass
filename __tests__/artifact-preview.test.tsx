// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { describe, expect, it } from "vitest"
import { ArtifactPreview, ARTIFACT_IFRAME_SANDBOX } from "@/components/docs/artifact-preview"

describe("ArtifactPreview", () => {
  it("uses the exact approved hostile-HTML sandbox and grants no iframe permissions", () => {
    render(<ArtifactPreview title="Prototype" html="<html><body>Hi</body></html>" />)
    const frame = screen.getByTitle("Prototype preview")
    expect(ARTIFACT_IFRAME_SANDBOX).toBe("allow-scripts")
    expect(frame).toHaveAttribute("sandbox", "allow-scripts")
    expect(frame).not.toHaveAttribute("allow")
    expect(frame.getAttribute("sandbox")).not.toMatch(/same-origin|forms|popups|downloads|top-navigation/)
  })

  it("opens external artifacts in a noopener noreferrer tab", () => {
    render(<ArtifactPreview title="External" externalUrl="https://example.com/prototype" />)
    const link = screen.getByRole("link", { name: /open external artifact/i })
    expect(link).toHaveAttribute("rel", "noopener noreferrer")
    expect(link).toHaveAttribute("target", "_blank")
  })

  it("removes the iframe and warns when uploaded HTML self-navigates", () => {
    const view = render(<ArtifactPreview title="Navigation Prototype" html="<html><a href='data:text/html,phish'>Go</a></html>" />)
    const frame = view.getByTitle("Navigation Prototype preview")
    fireEvent.load(frame)
    fireEvent.load(frame)
    expect(view.queryByTitle("Navigation Prototype preview")).not.toBeInTheDocument()
    expect(view.getByRole("alert")).toHaveTextContent(/navigation attempt blocked/i)
  })
})
