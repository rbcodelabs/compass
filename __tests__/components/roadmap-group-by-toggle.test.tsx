// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

import { RoadmapGroupByToggle } from "@/components/roadmap/roadmap-group-by-toggle"

/**
 * Base UI's SelectItem only commits a mouse click when a `pointerdown` primed
 * `allowMouseSelectionRef` first — see __tests__/components/study-builder.test.tsx
 * for the same recipe against the same components/ui/select.tsx primitive.
 */
function selectOption(option: HTMLElement) {
  fireEvent.pointerDown(option, { pointerType: "mouse" })
  fireEvent.click(option)
}

const set = vi.fn()
vi.mock("@/hooks/use-url-state", () => ({ useUrlState: () => ({ set }) }))

describe("RoadmapGroupByToggle", () => {
  afterEach(() => {
    cleanup()
    set.mockReset()
  })

  it("omits groupBy from the URL when Phase (the default) is chosen", () => {
    render(<RoadmapGroupByToggle value="squad" customFieldOptions={[]} />)
    fireEvent.click(screen.getByLabelText("Group timeline by"))
    selectOption(screen.getByRole("option", { name: "Phase" }))

    expect(set).toHaveBeenCalledWith({ groupBy: null })
  })

  it("sets groupBy=squad and groupBy=none for the built-in non-default options", () => {
    render(<RoadmapGroupByToggle value="phase" customFieldOptions={[]} />)

    fireEvent.click(screen.getByLabelText("Group timeline by"))
    selectOption(screen.getByRole("option", { name: "Squad" }))
    expect(set).toHaveBeenLastCalledWith({ groupBy: "squad" })

    fireEvent.click(screen.getByLabelText("Group timeline by"))
    selectOption(screen.getByRole("option", { name: "None" }))
    expect(set).toHaveBeenLastCalledWith({ groupBy: "none" })
  })

  it("offers each groupable custom field and sets groupBy to its field id", () => {
    render(
      <RoadmapGroupByToggle
        value="phase"
        customFieldOptions={[{ id: "field-1", label: "Product Area" }]}
      />
    )
    fireEvent.click(screen.getByLabelText("Group timeline by"))
    selectOption(screen.getByRole("option", { name: "Product Area" }))

    expect(set).toHaveBeenLastCalledWith({ groupBy: "field-1" })
  })

  it("renders no custom field options when none are groupable", () => {
    render(<RoadmapGroupByToggle value="phase" customFieldOptions={[]} />)
    fireEvent.click(screen.getByLabelText("Group timeline by"))

    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Phase",
      "Squad",
      "None",
    ])
  })

  describe("icon-only trigger", () => {
    it("shows no visible text, only an icon, and keeps its accessible name (both variants)", () => {
      const { unmount } = render(<RoadmapGroupByToggle value="squad" customFieldOptions={[]} />)
      const timeline = screen.getByLabelText("Group timeline by")
      // The only text is the chevron glyph (a jsdom stand-in for the icon, hidden by CSS); no label, no value.
      expect(timeline.textContent?.replace("▼", "")).toBe("")
      expect(timeline.querySelector("[data-slot=select-value]")).toBeNull()
      expect(timeline.querySelector("svg")).not.toBeNull()
      unmount()
      render(<RoadmapGroupByToggle variant="board" value="squad" customFieldOptions={[]} />)
      const board = screen.getByLabelText("Group board by")
      expect(board.textContent?.replace("▼", "")).toBe("")
      expect(board.querySelector("svg")).not.toBeNull()
    })

    it("marks the trigger active, with a dot, only for a non-default grouping", () => {
      const cases: Array<["timeline" | "board", string, boolean]> = [
        ["timeline", "phase", false], ["timeline", "squad", true], ["timeline", "none", true],
        ["board", "phase", false], ["board", "none", false], ["board", "squad", true], ["board", "field-1", true],
      ]
      for (const [variant, value, active] of cases) {
        const { unmount } = render(<RoadmapGroupByToggle variant={variant} value={value} customFieldOptions={[{ id: "field-1", label: "Product Area" }]} />)
        const trigger = screen.getByLabelText(variant === "board" ? "Group board by" : "Group timeline by")
        expect(trigger.querySelector("[data-testid=group-by-active-dot]") !== null, `${variant}:${value}`).toBe(active)
        expect(trigger.getAttribute("data-active") === "true", `${variant}:${value}`).toBe(active)
        unmount()
      }
    })

    it("names the current mode in a tooltip", async () => {
      const cases: Array<["timeline" | "board", string, string]> = [
        ["board", "phase", "No swimlanes"], ["board", "none", "No swimlanes"], ["board", "squad", "Swimlanes: Squad"],
        ["board", "field-1", "Swimlanes: Product Area"], ["timeline", "phase", "Group by: Phase"],
        ["timeline", "squad", "Group by: Squad"], ["timeline", "none", "Group by: None"], ["timeline", "field-1", "Group by: Product Area"],
      ]
      for (const [variant, value, text] of cases) {
        const { unmount } = render(<RoadmapGroupByToggle variant={variant} value={value} customFieldOptions={[{ id: "field-1", label: "Product Area" }]} />)
        const trigger = screen.getByLabelText(variant === "board" ? "Group board by" : "Group timeline by")
        fireEvent.focus(trigger)
        fireEvent.mouseEnter(trigger)
        fireEvent.pointerEnter(trigger)
        expect(await screen.findByText(text), `${variant}:${value}`).toBeInTheDocument()
        unmount()
      }
    })

    it("still opens a text list of options, and the board variant offers No swimlanes first", () => {
      render(<RoadmapGroupByToggle variant="board" value="phase" customFieldOptions={[{ id: "field-1", label: "Product Area" }]} />)
      fireEvent.click(screen.getByLabelText("Group board by"))
      expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["No swimlanes", "Squad", "Product Area"])
      selectOption(screen.getByRole("option", { name: "Squad" }))
      expect(set).toHaveBeenLastCalledWith({ groupBy: "squad" })
    })
  })
})
