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
    expect(field).toHaveClass("min-h-[34px]", "max-h-[150px]", "overflow-y-auto")
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

  it("shows Send (disabled while empty) and swaps it for Stop in the same slot while running", () => {
    const { rerender } = render(<Harness />)
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled()
    expect(screen.queryByRole("button", { name: "Stop this agent run" })).toBeNull()
    rerender(<Harness running stopTitle="Stop this run (Esc)" textareaDisabled />)
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull()
    const stop = screen.getByRole("button", { name: "Stop this agent run" })
    expect(stop).toHaveAttribute("title", "Stop this run (Esc)")
    expect(stop).toHaveClass("size-[34px]", "bg-destructive")
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

  it("moves focus from the disabled field to Stop when a run starts, and back when it ends", async () => {
    const { rerender } = render(<Harness />)
    screen.getByRole("textbox").focus()
    await act(async () => { rerender(<Harness running textareaDisabled />) })
    expect(screen.getByRole("button", { name: "Stop this agent run" })).toHaveFocus()
    await act(async () => { rerender(<Harness />) })
    expect(screen.getByRole("textbox")).toHaveFocus()
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
