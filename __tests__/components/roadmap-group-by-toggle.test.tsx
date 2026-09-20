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
})
