// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

const nav = vi.hoisted(() => ({ pathname: "" }))
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }))
vi.mock("@/components/discovery/discovery-rail", () => ({ DiscoveryRail: ({ activeOpportunityId }: { activeOpportunityId: string }) => <div data-testid="rail">{activeOpportunityId}</div> }))
import { DiscoveryShell } from "@/components/discovery/discovery-shell"

const show = (pathname: string) => {
  nav.pathname = pathname
  render(<DiscoveryShell orgSlug="acme" workspaceSlug="growth" opportunities={[]}><p>child</p></DiscoveryShell>)
}
afterEach(cleanup)

describe("DiscoveryShell rail", () => {
  it("shows the opportunity rail on the detail page and on its spec page", () => {
    show("/acme/growth/discovery/OPP-4")
    expect(screen.getByTestId("rail")).toHaveTextContent("OPP-4")
    cleanup()
    show("/acme/growth/discovery/OPP-4/spec")
    expect(screen.getByTestId("rail")).toHaveTextContent("OPP-4")
    expect(screen.getByText("child")).toBeInTheDocument()
  })
  it("does not show it on the index, the tree or unrelated sub-pages", () => {
    for (const path of ["/acme/growth/discovery", "/acme/growth/discovery/tree", "/acme/growth/discovery/OPP-4/other"]) {
      show(path)
      expect(screen.queryByTestId("rail")).toBeNull()
      cleanup()
    }
  })
})
