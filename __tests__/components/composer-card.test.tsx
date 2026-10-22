// @vitest-environment jsdom
//
// The composer card: auto-growing field, send/stop in one slot, Escape to stop, strip and footer visibility.
import { createRef, useState, type ComponentProps } from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ComposerCard } from "@/components/agent/composer/composer-card"

type Overrides = Partial<ComponentProps<typeof ComposerCard>>

function Harness(overrides: Overrides) {
  const [value, setValue] = useState("")
  return (
    <ComposerCard
      textareaRef={createRef<HTMLTextAreaElement>()}
      value={value}
      onChange={setValue}
      onSend={() => {}}
      textareaDisabled={false}
      sendDisabled={!value.trim()}
      running={false}
      onStop={() => {}}
      {...overrides}
    />
  )
}

afterEach(cleanup)

describe("ComposerCard", () => {
  it("grows with its content up to 150px, then scrolls (the stylesheet caps it at max-h-[150px])", () => {
    render(<Harness />)
    const field = screen.getByRole("textbox")
    expect(field).toHaveClass("min-h-[34px]", "overflow-y-auto")
    expect(field.style.maxHeight).toBe("150px")
    Object.defineProperty(field, "scrollHeight", { configurable: true, get: () => 80 })
    fireEvent.change(field, { target: { value: "a\nb\nc" } })
    expect(field.style.height).toBe("80px")
    Object.defineProperty(field, "scrollHeight", { configurable: true, get: () => 400 })
    fireEvent.change(field, { target: { value: "a\nb\nc\nd" } })
    expect(field.style.height).toBe("150px")
  })

  it("Enter sends, Shift+Enter does not, and Enter during IME composition does not", () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    const field = screen.getByRole("textbox")
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(field, { key: "Enter", isComposing: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(field, { key: "Enter" })
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it("does not send on the Enter that commits an IME candidate, including Safari where isComposing is already false (keyCode 229)", () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", keyCode: 229, isComposing: false })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", keyCode: 13 })
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it("has a stable accessible name and a screen-reader description of the send keys", () => {
    const { rerender } = render(<Harness />)
    const field = screen.getByRole("textbox", { name: "Message the agent" })
    expect(field).toHaveAccessibleDescription("Enter to send. Shift+Enter for a new line.")
    rerender(<Harness running textareaDisabled />)
    expect(screen.getByRole("textbox", { name: "Message the agent" })).toHaveAttribute("placeholder", "Waiting for the answer…")
  })

  it("recomputes the height when the field's width changes, not only its value", () => {
    let notify: () => void = () => {}
    vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { notify = cb } observe() {} disconnect() {} })
    render(<Harness />)
    const field = screen.getByRole("textbox")
    let width = 300
    Object.defineProperty(field, "clientWidth", { configurable: true, get: () => width })
    Object.defineProperty(field, "scrollHeight", { configurable: true, get: () => 60 })
    notify() // same width as at mount (0 -> 300 counts as a change, so settle it first)
    width = 200
    Object.defineProperty(field, "scrollHeight", { configurable: true, get: () => 90 })
    notify()
    expect(field.style.height).toBe("90px")
    vi.unstubAllGlobals()
  })

  it("shows Send (disabled while empty) and swaps it for Stop in the same slot while running", () => {
    const { rerender } = render(<Harness />)
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled()
    expect(screen.queryByRole("button", { name: "Stop this agent run" })).toBeNull()
    rerender(<Harness running stopTitle="Stop this run (Esc)" textareaDisabled />)
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull()
    const stop = screen.getByRole("button", { name: "Stop this agent run" })
    expect(stop).toHaveAttribute("title", "Stop this run (Esc)")
    expect(stop).toHaveClass("size-9", "bg-destructive")
    expect(screen.getByRole("textbox")).toHaveAttribute("placeholder", "Waiting for the answer…")
  })

  it("stop calls onStop; a disabled stop does not, and Escape does nothing then", () => {
    const onStop = vi.fn()
    const { rerender } = render(<Harness running textareaDisabled onStop={onStop} />)
    fireEvent.click(screen.getByRole("button", { name: "Stop this agent run" }))
    expect(onStop).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(screen.getByRole("button", { name: "Stop this agent run" }), { key: "Escape" })
    expect(onStop).toHaveBeenCalledTimes(2)

    onStop.mockClear()
    rerender(<Harness running textareaDisabled onStop={onStop} stopDisabled />)
    expect(screen.getByRole("button", { name: "Stop this agent run" })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole("button", { name: "Stop this agent run" }), { key: "Escape" })
    expect(onStop).not.toHaveBeenCalled()
  })

  it("Escape stops only while a run is in flight", () => {
    const onStop = vi.fn()
    const { rerender } = render(<Harness onStop={onStop} />)
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" })
    expect(onStop).not.toHaveBeenCalled()
    rerender(<Harness onStop={onStop} running textareaDisabled />)
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" })
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it("Escape with a list open and a run active belongs to the list: it does not stop the run", () => {
    const onStop = vi.fn()
    render(<Harness running onStop={onStop} chips={<div role="dialog" aria-label="Agent options"><div role="listbox" aria-label="Agent"><div role="option" aria-selected tabIndex={-1}>Default</div></div></div>} />)
    fireEvent.keyDown(screen.getByRole("option"), { key: "Escape" })
    expect(onStop).not.toHaveBeenCalled()
  })

  it("moves focus to Stop only for a run this user just sent from the composer, and back to the field once it is enabled", async () => {
    const { rerender } = render(<Harness />)
    screen.getByRole("textbox").focus()
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" }) // the send that starts the run
    await act(async () => { rerender(<Harness running textareaDisabled />) })
    expect(screen.getByRole("button", { name: "Stop this agent run" })).toHaveFocus()
    // The run ends but the field is still disabled for a render: focus waits for it.
    await act(async () => { rerender(<Harness textareaDisabled />) })
    expect(screen.getByRole("textbox")).not.toHaveFocus()
    await act(async () => { rerender(<Harness />) })
    expect(screen.getByRole("textbox")).toHaveFocus()
  })

  it("does not steal focus for a run it did not send (reattach, another participant, or focus elsewhere)", async () => {
    const { rerender } = render(<><button>elsewhere</button><Harness /></>)
    screen.getByRole("button", { name: "elsewhere" }).focus()
    await act(async () => { rerender(<><button>elsewhere</button><Harness running runStartedByMe={false} /></>) })
    expect(screen.getByRole("button", { name: "elsewhere" })).toHaveFocus()
    // Even right after a send, a run owned by someone else stays put.
    await act(async () => { rerender(<><button>elsewhere</button><Harness /></>) })
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    await act(async () => { rerender(<><button>elsewhere</button><Harness running runStartedByMe={false} /></>) })
    expect(screen.getByRole("button", { name: "elsewhere" })).toHaveFocus()
  })

  it("does not pull focus back to the field when the user moved focus away from Stop", async () => {
    const { rerender } = render(<><button>elsewhere</button><Harness /></>)
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    await act(async () => { rerender(<><button>elsewhere</button><Harness running textareaDisabled /></>) })
    const elsewhere = screen.getByRole("button", { name: "elsewhere" })
    await act(async () => { elsewhere.focus() })
    await act(async () => { rerender(<><button>elsewhere</button><Harness /></>) })
    expect(elsewhere).toHaveFocus()
  })

  it("does not grab focus when it mounts into an already-running state", () => {
    render(<><button>elsewhere</button><Harness running textareaDisabled /></>)
    expect(screen.getByRole("button", { name: "Stop this agent run" })).not.toHaveFocus()
  })

  it("disables the field and Send as told", () => {
    render(<Harness textareaDisabled sendDisabled />)
    expect(screen.getByRole("textbox")).toBeDisabled()
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled()
  })

  it("hides the top strip and footer when there is nothing for them", () => {
    const { container, rerender } = render(<Harness />)
    expect(container.querySelector('[data-slot="composer-strip"]')).toBeNull()
    expect(container.querySelector('[data-slot="composer-footer"]')).toBeNull()
    rerender(<Harness contextChips={<span>a chip</span>} chips={<button>Agent: x</button>} />)
    expect(container.querySelector('[data-slot="composer-strip"]')).toHaveTextContent("a chip")
    expect(container.querySelector('[data-slot="composer-footer"]')).toHaveTextContent("Enter to send · Shift+Enter for a new line")
  })

  it("puts the focus ring on the whole card", () => {
    const { container } = render(<Harness />)
    expect(container.querySelector('[data-slot="composer-card"]')).toHaveClass("focus-within:border-ring", "focus-within:ring-[3px]", "rounded-xl")
  })
})
