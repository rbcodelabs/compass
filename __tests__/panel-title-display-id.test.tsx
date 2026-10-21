// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }))

import { PanelTitle } from "@/components/panels/panel-parts"

describe("PanelTitle display ID", () => {
  afterEach(cleanup)

  it("shows the display ID above the title when the row is numbered", () => {
    render(<PanelTitle title="Fix login" displayId="TASK-12" />)
    expect(screen.getByTestId("display-id")).toHaveTextContent("TASK-12")
    expect(screen.getByRole("heading", { name: "Fix login" })).toBeInTheDocument()
  })

  it("shows nothing extra for an un-numbered row", () => {
    render(<PanelTitle title="Fix login" displayId={null} />)
    expect(screen.queryByTestId("display-id")).toBeNull()
  })
})
