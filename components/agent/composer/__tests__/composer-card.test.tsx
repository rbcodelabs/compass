// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { createRef } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ComposerCard } from "@/components/agent/composer/composer-card"

afterEach(cleanup)

function renderCard() {
  return render(
    <ComposerCard
      textareaRef={createRef<HTMLTextAreaElement>()}
      value=""
      onChange={vi.fn()}
      onSend={vi.fn()}
      textareaDisabled={false}
      sendDisabled={false}
      running={false}
      onStop={vi.fn()}
      chips={
        <>
          <button type="button">Tools</button>
          <button type="button">Model</button>
        </>
      }
    />,
  )
}

describe("ComposerCard footer", () => {
  // Layouts wrap or scroll, never clip: with the Participation chip, the @mention pill, Tools and Model all present, the footer
  // is wider than a phone or the docked Conversation panel, so its chips must wrap onto a second row instead of overflowing
  // the card (TASK-197) or leaving Tools/Model off-screen at 390px.
  it("wraps its chips and lets the container shrink", () => {
    const { container } = renderCard()
    const footer = container.querySelector('[data-slot="composer-footer"]')
    expect(footer).not.toBeNull()
    expect(footer!.classList.contains("flex-wrap")).toBe(true)
    expect(footer!.classList.contains("min-w-0")).toBe(true)
  })
})
