// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ResearchChat } from "@/components/research/research-chat"

describe("ResearchChat", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("shows a retryable error when the interviewer cannot answer", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sessionId: "session-1",
        message: "Tell me about the last time you planned your week.",
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "Interviewer is not configured",
      }), { status: 503, headers: { "Content-Type": "application/json" } }))
    vi.stubGlobal("fetch", fetchMock)

    render(<ResearchChat token="study-token" />)
    fireEvent.click(screen.getByRole("button", { name: "Start interview" }))
    expect(await screen.findByText("Tell me about the last time you planned your week.")).toBeVisible()

    fireEvent.change(screen.getByRole("textbox", { name: "Your response" }), {
      target: { value: "I use a spreadsheet." },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("This interview isn’t available yet")
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled()
    expect(screen.getByText("I use a spreadsheet.")).toBeVisible()
  })
})
