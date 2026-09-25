// @vitest-environment jsdom
import { useState } from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { OptionListEditor } from "@/components/custom-fields/option-list-editor"
import type { SelectOptionInput } from "@/lib/shared-field-options"

/**
 * Replaces the "Options (comma-separated)" text box, which re-slugged every
 * value on save (orphaning stored values on a rename), dropped colours, and
 * could not hold a label containing a comma.
 */

/**
 * jsdom lays nothing out, so every rect is zero and dnd-kit's keyboard
 * coordinates could never find a "next" row. Give each sortable row a stacked
 * 40px slot by its position in the list so the sensor behaves as in a browser.
 */
const ROW_HEIGHT = 40
beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    // The list itself spans all its rows — the drag is clamped to it.
    if (this.querySelector(":scope > [data-option-row]")) {
      const height = this.children.length * ROW_HEIGHT
      return { x: 0, y: 0, top: 0, left: 0, width: 300, height, right: 300, bottom: height, toJSON() {} } as DOMRect
    }
    const row = this.closest("[data-option-row]")
    const index = row?.parentElement ? Array.from(row.parentElement.children).indexOf(row) : 0
    const top = row ? index * ROW_HEIGHT : 0
    const height = row ? ROW_HEIGHT - 4 : 0
    return { x: 0, y: top, top, left: 0, width: row ? 300 : 0, height, right: row ? 300 : 0, bottom: top + height, toJSON() {} } as DOMRect
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** dnd-kit's keyboard sensor reads event.code and moves on the following frame. */
async function press(element: Element | Window, code: string) {
  await act(async () => {
    fireEvent.keyDown(element, { code, key: code === "Space" ? " " : code })
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

function Harness({
  initial,
  onChange,
  onSubmit = vi.fn(),
}: {
  initial: SelectOptionInput[]
  onChange?: (options: SelectOptionInput[]) => void
  onSubmit?: () => void
}) {
  const [options, setOptions] = useState(initial)
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <OptionListEditor
        label="Options"
        value={options}
        onChange={(next) => {
          setOptions(next)
          onChange?.(next)
        }}
      />
      <output data-testid="state">{JSON.stringify(options)}</output>
    </form>
  )
}

function state(): SelectOptionInput[] {
  return JSON.parse(screen.getByTestId("state").textContent ?? "[]")
}

const priorities: SelectOptionInput[] = [
  { label: "Low", value: "low", color: "#16a34a" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
]

describe("OptionListEditor", () => {
  it("renders one labelled row per option with accessible controls", () => {
    render(<Harness initial={priorities} />)
    expect(screen.getByLabelText("Option 1 label")).toHaveValue("Low")
    expect(screen.getByLabelText("Option 3 label")).toHaveValue("High")
    expect(screen.getByRole("button", { name: "Remove Low" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reorder Low" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reorder High" })).toBeInTheDocument()
    // Reordering is by the drag handle now; the arrow buttons are gone.
    expect(screen.queryByRole("button", { name: /^Move / })).not.toBeInTheDocument()
  })

  it("keeps an existing option's value and colour when its label is renamed", () => {
    render(<Harness initial={priorities} />)
    fireEvent.change(screen.getByLabelText("Option 1 label"), { target: { value: "Minor" } })
    expect(state()[0]).toEqual({ label: "Minor", value: "low", color: "#16a34a" })
  })

  it("reorders with the keyboard through the drag handle and announces it by label", async () => {
    const onSubmit = vi.fn()
    render(<Harness initial={priorities} onSubmit={onSubmit} />)
    const handle = screen.getByRole("button", { name: "Reorder Low" })
    handle.focus()

    await press(handle, "Space")
    expect(document.body).toHaveTextContent("Picked up Low.")
    await press(handle, "ArrowDown")
    expect(document.body).toHaveTextContent("Moved Low to position 2 of 3.")
    await press(handle, "Space")

    expect(state().map((o) => o.value)).toEqual(["medium", "low", "high"])
    expect(document.body).toHaveTextContent("Dropped Low at position 2 of 3.")
    // Picking up and dropping inside the form must never submit it.
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("cancels a keyboard drag with Escape and leaves the order alone", async () => {
    render(<Harness initial={priorities} />)
    const handle = screen.getByRole("button", { name: "Reorder Low" })
    handle.focus()
    await press(handle, "Space")
    await press(handle, "ArrowDown")
    await press(handle, "Escape")
    expect(state().map((o) => o.value)).toEqual(["low", "medium", "high"])
    expect(document.body).toHaveTextContent("Reordering cancelled. Low returned to position 1.")
  })

  it("reorders with Alt+Arrow from a label input", () => {
    render(<Harness initial={priorities} />)
    const low = screen.getByLabelText("Option 1 label")
    low.focus()
    fireEvent.keyDown(low, { key: "ArrowDown", altKey: true })
    expect(state().map((o) => o.value)).toEqual(["medium", "low", "high"])
    // Focus follows the moved row, so a second Alt+Down keeps moving "Low".
    expect(screen.getByLabelText("Option 2 label")).toHaveValue("Low")
    expect(screen.getByLabelText("Option 2 label")).toHaveFocus()
    fireEvent.keyDown(screen.getByLabelText("Option 2 label"), { key: "ArrowDown", altKey: true })
    expect(state().map((o) => o.value)).toEqual(["medium", "high", "low"])
  })

  it("removes an option", () => {
    render(<Harness initial={priorities} />)
    fireEvent.click(screen.getByRole("button", { name: "Remove Medium" }))
    expect(state().map((o) => o.value)).toEqual(["low", "high"])
  })

  it("sets and clears a colour from the swatch palette", () => {
    render(<Harness initial={priorities} />)
    fireEvent.click(screen.getByRole("button", { name: "Color for Medium" }))
    fireEvent.click(screen.getByRole("button", { name: "Blue" }))
    expect(state()[1]).toEqual({ label: "Medium", value: "medium", color: "#2563eb" })

    fireEvent.click(screen.getByRole("button", { name: "Color for Low" }))
    fireEvent.click(screen.getByRole("button", { name: "No color" }))
    expect(state()[0]).toEqual({ label: "Low", value: "low" })
  })

  it("adds on Enter, keeps focus in the add input, and never submits the parent form", () => {
    const onSubmit = vi.fn()
    render(<Harness initial={[]} onSubmit={onSubmit} />)
    const add = screen.getByLabelText("Add option")
    add.focus()
    fireEvent.change(add, { target: { value: "Low" } })
    fireEvent.keyDown(add, { key: "Enter" })
    fireEvent.change(add, { target: { value: "Medium" } })
    fireEvent.keyDown(add, { key: "Enter" })

    expect(state()).toEqual([{ label: "Low" }, { label: "Medium" }])
    expect(add).toHaveValue("")
    expect(add).toHaveFocus()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("keeps a typed-but-not-entered option when focus leaves the add input", () => {
    render(<Harness initial={priorities} />)
    const add = screen.getByLabelText("Add option")
    fireEvent.change(add, { target: { value: "Urgent" } })
    fireEvent.blur(add)
    expect(state().map((o) => o.label)).toEqual(["Low", "Medium", "High", "Urgent"])
    expect(add).toHaveValue("")
  })

  it("does not complain about an empty add input on blur", () => {
    render(<Harness initial={priorities} />)
    fireEvent.blur(screen.getByLabelText("Add option"))
    expect(screen.queryByText(/type a label/i)).not.toBeInTheDocument()
  })

  it("splits pasted multi-line text into separate options", () => {
    render(<Harness initial={[]} />)
    fireEvent.paste(screen.getByLabelText("Add option"), {
      clipboardData: { getData: () => "Acme, Inc.\nGlobex\nInitech" },
    })
    expect(state().map((o) => o.label)).toEqual(["Acme, Inc.", "Globex", "Initech"])
  })

  it("splits a pasted comma-separated line into separate options", () => {
    render(<Harness initial={[]} />)
    fireEvent.paste(screen.getByLabelText("Add option"), {
      clipboardData: { getData: () => "Low, Medium, High" },
    })
    expect(state().map((o) => o.label)).toEqual(["Low", "Medium", "High"])
  })

  it("adds a typed label containing a comma as one option", () => {
    render(<Harness initial={[]} />)
    const add = screen.getByLabelText("Add option")
    fireEvent.change(add, { target: { value: "Acme, Inc." } })
    fireEvent.keyDown(add, { key: "Enter" })
    expect(state()).toEqual([{ label: "Acme, Inc." }])
  })

  it("lets a single-line paste land in the input as plain text", () => {
    render(<Harness initial={[]} />)
    const add = screen.getByLabelText("Add option")
    const notPrevented = fireEvent.paste(add, { clipboardData: { getData: () => "Just one" } })
    expect(notPrevented).toBe(true)
    expect(state()).toEqual([])
  })

  it("explains a duplicate instead of silently dropping it", () => {
    const onChange = vi.fn()
    render(<Harness initial={priorities} onChange={onChange} />)
    const add = screen.getByLabelText("Add option")
    fireEvent.change(add, { target: { value: "low" } })
    fireEvent.keyDown(add, { key: "Enter" })
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText(/already in the list/i)).toBeInTheDocument()
    expect(add).toHaveValue("low")
  })

  it("explains a blank entry", () => {
    render(<Harness initial={[]} />)
    const add = screen.getByLabelText("Add option")
    fireEvent.keyDown(add, { key: "Enter" })
    expect(screen.getByText(/type a label/i)).toBeInTheDocument()
  })

  it("flags a row renamed to collide with another option", () => {
    render(<Harness initial={priorities} />)
    const row = screen.getByLabelText("Option 3 label")
    fireEvent.change(row, { target: { value: "medium" } })
    expect(row).toHaveAttribute("aria-invalid", "true")
    expect(screen.getByText("Duplicate of “Medium”")).toBeInTheDocument()
  })
})
