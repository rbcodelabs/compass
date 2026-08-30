// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/components/research/research-chat", () => ({ ResearchChat: ({ guided }: { guided?: boolean }) => <div data-testid="chat">{guided ? "guided-chat" : "interview-chat"}</div> }))
vi.mock("@/components/research/research-voice", () => ({ ResearchVoice: () => <div data-testid="voice">voice</div> }))

import { ResearchExperience } from "@/components/research/research-experience"

afterEach(() => { cleanup(); localStorage.clear() })

describe("guided research participant experience", () => {
  const props = { token: "study-token", studyType: "USABILITY_TEST" as const, appUrl: "https://example.com/app", studyName: "Navigation test" }

  it("explains think-aloud research and lets the participant choose chat or voice", () => {
    render(<ResearchExperience {...props} />)
    expect(screen.getByText(/think aloud/i)).toBeVisible()
    expect(screen.getByRole("button", { name: /Use chat/i })).toBeEnabled()
    expect(screen.getByRole("button", { name: /Use voice/i })).toBeEnabled()
  })

  it("shows a restrictive live-product frame and persistent safe external fallback", () => {
    render(<ResearchExperience {...props} />)
    fireEvent.click(screen.getByRole("button", { name: /Use chat/i }))
    const frame = screen.getByTitle("Live product for Navigation test")
    expect(frame).toHaveAttribute("src", "https://example.com/app")
    expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-forms allow-popups")
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer")
    const openProduct = screen.getByRole("link", { name: /Open product/i })
    expect(openProduct).toHaveAttribute("rel", "noopener noreferrer")
    expect(openProduct.parentElement).toHaveClass("sticky", "top-0", "lg:static")
    const experience = frame.parentElement?.parentElement
    expect(experience).toHaveClass("lg:overflow-hidden")
    expect(experience).not.toHaveClass("overflow-hidden")
    expect(screen.getByTestId("chat")).toHaveTextContent("guided-chat")
  })

  it("keeps customer interviews on the existing chat flow", () => {
    render(<ResearchExperience token="study-token" studyName="Interview" studyType="CUSTOMER_INTERVIEW" appUrl={null} />)
    expect(screen.getByTestId("chat")).toHaveTextContent("interview-chat")
    expect(screen.queryByRole("button", { name: /Use voice/i })).not.toBeInTheDocument()
  })

  it("restores the chosen modality after a participant reload", async () => {
    localStorage.setItem("compass-research-modality-study-token", "CHAT")
    render(<ResearchExperience {...props} />)
    expect(await screen.findByTestId("chat")).toHaveTextContent("guided-chat")
    expect(screen.queryByRole("button", { name: /Use voice/i })).not.toBeInTheDocument()
  })
})
