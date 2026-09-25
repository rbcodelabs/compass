// @vitest-environment jsdom
import { useState } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"

import { OptionListEditor } from "@/components/custom-fields/option-list-editor"
import type { SelectOptionInput } from "@/lib/shared-field-options"

/**
 * Replaces the "Options (comma-separated)" text box, which re-slugged every
 * value on save (orphaning stored values on a rename), dropped colours, and
 * could not hold a label containing a comma.
 */

afterEach(cleanup)

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
    expect(screen.getByRole("button", { name: "Move Low up" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Move High down" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Move Medium up" })).toBeEnabled()
  })

  it("keeps an existing option's value and colour when its label is renamed", () => {
    render(<Harness initial={priorities} />)
    fireEvent.change(screen.getByLabelText("Option 1 label"), { target: { value: "Minor" } })
    expect(state()[0]).toEqual({ label: "Minor", value: "low", color: "#16a34a" })
  })

  it("reorders with the move buttons", () => {
    render(<Harness initial={priorities} />)
    fireEvent.click(screen.getByRole("button", { name: "Move High up" }))
    expect(state().map((o) => o.value)).toEqual(["low", "high", "medium"])
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
