// @vitest-environment jsdom
//
// The composer's Agent/Model chip: an accessible listbox popover (desktop) or bottom sheet (phone width).
import { useState } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ChoiceChip, type ChoiceOption } from "@/components/agent/composer/choice-chip"

const OPTIONS: ChoiceOption[] = [
  { value: "", label: "Default (Compass Agent)" },
  { value: "builtin", label: "Compass Agent" },
  { value: "a-1", label: "Research Analyst", shared: true },
  { value: "a-2", label: "A very long agent name that cannot possibly fit in the chip at any width at all", shared: true },
]

function Harness(props: { onChange?: (v: string) => void; disabled?: boolean; initial?: string }) {
  const [value, setValue] = useState(props.initial ?? "")
  return <ChoiceChip kind="Agent" icon={<span />} options={OPTIONS} value={value} disabled={props.disabled} onChange={(v) => { setValue(v); props.onChange?.(v) }} />
}

// No user-event in this repo: keys go to the focused element, as a browser would deliver them.
const key = (name: string) => fireEvent.keyDown(document.activeElement ?? document.body, { key: name })
const click = (el: Element) => act(async () => { fireEvent.click(el) })

function mockNarrow(narrow: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: narrow && query.includes("max-width"), media: query, addEventListener: () => {}, removeEventListener: () => {} }))
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe("ChoiceChip", () => {
  it("is a button named for its kind and current value, with listbox semantics", () => {
    render(<Harness />)
    const chip = screen.getByRole("button", { name: "Agent: Default (Compass Agent)" })
    expect(chip).toHaveAttribute("aria-haspopup", "dialog")
    expect(chip).toHaveAttribute("aria-expanded", "false")
  })

  it("opens a listbox with the selected row checked, and closes on Escape returning focus to the chip", async () => {
    render(<Harness initial="builtin" />)
    const chip = screen.getByRole("button", { name: "Agent: Compass Agent" })
    await click(chip)
    expect(chip).toHaveAttribute("aria-expanded", "true")
    const listbox = await screen.findByRole("listbox", { name: "Agent" })
    const options = within(listbox).getAllByRole("option")
    expect(options).toHaveLength(4)
    expect(screen.getByRole("option", { name: "Compass Agent" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("option", { name: "Research Analyst (shared)" })).toHaveAttribute("aria-selected", "false")
    await waitFor(() => expect(screen.getByRole("option", { name: "Compass Agent" })).toHaveFocus())
    key("Escape")
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())
    await waitFor(() => expect(chip).toHaveFocus())
    expect(chip).toHaveAttribute("aria-expanded", "false")
  })

  it("opens from the keyboard (ArrowDown, Enter, Space), moves with arrows/Home/End, and selects with Enter", async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const chip = screen.getByRole("button", { name: /^Agent:/ })
    chip.focus()
    key("ArrowDown")
    await screen.findByRole("listbox")
    await waitFor(() => expect(screen.getByRole("option", { name: "Default (Compass Agent)" })).toHaveFocus())
    key("ArrowDown")
    expect(screen.getByRole("option", { name: "Compass Agent" })).toHaveFocus()
    key("End")
    expect(screen.getAllByRole("option")[3]).toHaveFocus()
    key("ArrowDown") // wraps
    expect(screen.getAllByRole("option")[0]).toHaveFocus()
    key("Home"); key("ArrowDown"); key("ArrowDown"); key("Enter")
    expect(onChange).toHaveBeenCalledWith("a-1")
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())
    expect(screen.getByRole("button", { name: "Agent: Research Analyst (shared)" })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole("button", { name: /^Agent:/ })).toHaveFocus())
    // ArrowUp opens it as well (Enter and Space are the browser's native button activation, covered by the E2E spec).
    key("ArrowUp")
    await screen.findByRole("listbox")
  })

  it("selects with Space and does not call onChange for the row that is already selected", async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await click(screen.getByRole("button", { name: /^Agent:/ }))
    await screen.findByRole("listbox")
    await waitFor(() => expect(screen.getAllByRole("option")[0]).toHaveFocus())
    key(" ")
    expect(onChange).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())
  })

  it("selects by click", async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await click(screen.getByRole("button", { name: /^Agent:/ }))
    await click(await screen.findByRole("option", { name: "Compass Agent" }))
    expect(onChange).toHaveBeenCalledWith("builtin")
  })

  it("is inert while disabled, and closes if it becomes disabled while open", async () => {
    const { rerender } = render(<Harness disabled />)
    const chip = screen.getByRole("button", { name: /^Agent:/ })
    expect(chip).toBeDisabled()
    await click(chip)
    expect(screen.queryByRole("listbox")).toBeNull()

    function Toggle() {
      const [disabled, setDisabled] = useState(false)
      return <><button onClick={() => setDisabled(true)}>lock</button><ChoiceChip kind="Model" icon={<span />} options={OPTIONS} value="" onChange={() => {}} disabled={disabled} /></>
    }
    rerender(<Toggle />)
    await click(screen.getByRole("button", { name: /^Model:/ }))
    await screen.findByRole("listbox")
    await act(async () => { fireEvent.click(screen.getByText("lock")) })
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())
  })

  it("points aria-controls at the open popup, which holds the listbox", async () => {
    render(<Harness />)
    const chip = screen.getByRole("button", { name: /^Agent:/ })
    expect(chip).not.toHaveAttribute("aria-controls")
    await click(chip)
    const listbox = await screen.findByRole("listbox", { name: "Agent" })
    const id = chip.getAttribute("aria-controls")!
    expect(id).toBeTruthy()
    expect(document.getElementById(id)).toContainElement(listbox)
  })

  it("stays closed when re-enabled after having been disabled while open", async () => {
    function Toggle() {
      const [disabled, setDisabled] = useState(false)
      return <><button onClick={() => setDisabled((d) => !d)}>flip</button><ChoiceChip kind="Model" icon={<span />} options={OPTIONS} value="" onChange={() => {}} disabled={disabled} /></>
    }
    render(<Toggle />)
    await click(screen.getByRole("button", { name: /^Model:/ }))
    await screen.findByRole("listbox")
    await click(screen.getByText("flip"))
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())
    await click(screen.getByText("flip"))
    expect(screen.getByRole("button", { name: /^Model:/ })).toBeEnabled()
    expect(screen.getByRole("button", { name: /^Model:/ })).toHaveAttribute("aria-expanded", "false")
    await act(async () => {})
    expect(screen.queryByRole("listbox")).toBeNull()
  })

  it("truncates the name but never the (shared) marker", () => {
    render(<Harness initial="a-2" />)
    const chip = screen.getByRole("button", { name: /^Agent:/ })
    const name = chip.querySelector('[data-slot="choice-name"]')!
    const shared = chip.querySelector('[data-slot="choice-shared"]')!
    expect(name).toHaveClass("truncate")
    expect(name).toHaveClass("min-w-0")
    expect(shared).toHaveClass("shrink-0")
    expect(shared).not.toHaveClass("truncate")
  })

  it("renders a bottom sheet with 44px rows below the sm breakpoint", async () => {
    mockNarrow(true)
    render(<Harness />)
    await click(screen.getByRole("button", { name: /^Agent:/ }))
    const sheet = await screen.findByTestId("agent-sheet")
    expect(sheet).toHaveAttribute("data-side", "bottom")
    for (const option of within(sheet).getAllByRole("option")) expect(option).toHaveClass("h-11")
    await click(within(sheet).getByRole("option", { name: "Compass Agent" }))
    await waitFor(() => expect(screen.queryByTestId("agent-sheet")).toBeNull())
    expect(screen.getByRole("button", { name: "Agent: Compass Agent" })).toBeInTheDocument()
  })

  it("keeps 32px rows in the popover on wide viewports", async () => {
    mockNarrow(false)
    render(<Harness />)
    await click(screen.getByRole("button", { name: /^Agent:/ }))
    await screen.findByRole("listbox")
    expect(screen.queryByTestId("agent-sheet")).toBeNull()
    for (const option of screen.getAllByRole("option")) expect(option).toHaveClass("h-8")
  })
})
