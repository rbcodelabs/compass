// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { ViewChainAction } from "@/components/panels/view-chain-action"

afterEach(cleanup)
const props = { orgSlug: "acme", workspaceSlug: "ws" }

describe("ViewChainAction", () => {
  it("links to /graph?focus=<TYPE>:<id> for core-chain entities when enabled", () => {
    render(<ViewChainAction enabled {...props} type="opportunity" id="OPP-12" />)
    const link = screen.getByRole("link", { name: "View chain" })
    expect(link.getAttribute("href")).toBe("/acme/ws/graph?focus=OPPORTUNITY%3AOPP-12")
  })

  it("renders nothing when the graph is off or the type has no node", () => {
    const { container, rerender } = render(<ViewChainAction enabled={false} {...props} type="opportunity" id="x" />)
    expect(container.innerHTML).toBe("")
    rerender(<ViewChainAction enabled {...props} type="keyResult" id="x" />)
    expect(container.innerHTML).toBe("")
    rerender(<ViewChainAction enabled {...props} type="task" id="x" />)
    expect(container.innerHTML).toBe("")
  })
})
