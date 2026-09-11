// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/components/research/research-chat", () => ({ ResearchChat: ({ guided }: { guided?: boolean }) => <div data-testid="chat">{guided ? "guided-chat" : "interview-chat"}</div> }))
vi.mock("@/components/research/research-voice", () => ({ ResearchVoice: ({ onUseChat }: { onUseChat?: () => void }) => <div data-testid="voice">voice{onUseChat && <button onClick={onUseChat}>Voice fallback</button>}</div> }))

import { ResearchExperience } from "@/components/research/research-experience"

afterEach(() => { cleanup(); localStorage.clear() })

describe("guided research participant experience", () => {
  const props = { token: "study-token", studyType: "USABILITY_TEST" as const, appUrl: "https://example.com/app", studyName: "Navigation test", legacyVoiceEnabled: true }

  it("keeps guided research on chat when authoritative voice is disabled", () => {
    render(<ResearchExperience {...props} legacyVoiceEnabled={false} />)
    expect(screen.getByTestId("chat")).toHaveTextContent("guided-chat")
    expect(screen.queryByRole("button", { name: /Use voice/i })).not.toBeInTheDocument()
    expect(screen.getByTitle("Live product for Navigation test")).toHaveAttribute("src", props.appUrl)
    expect(screen.getByRole("link", { name: /Open product/i })).toHaveAttribute("rel", "noopener noreferrer")
  })

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
    render(<ResearchExperience token="study-token" studyName="Interview" studyType="CUSTOMER_INTERVIEW" appUrl={null} discoveryVoiceEnabled={false} />)
    expect(screen.getByTestId("chat")).toHaveTextContent("interview-chat")
    expect(screen.queryByRole("button", { name: /Use voice/i })).not.toBeInTheDocument()
  })

  it("offers gated customer interviews chat or voice without a product frame", () => {
    render(<ResearchExperience token="study-token" studyName="Interview" studyType="CUSTOMER_INTERVIEW" appUrl={null} legacyVoiceEnabled discoveryVoiceEnabled />)
    expect(screen.getByRole("button", { name: /Use chat/i })).toBeEnabled()
    fireEvent.click(screen.getByRole("button", { name: /Use voice/i }))
    expect(screen.getByTestId("voice")).toBeVisible()
    expect(screen.queryByTitle(/Live product/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Voice fallback" }))
    expect(screen.getByTestId("chat")).toHaveTextContent("interview-chat")
  })

  it("requires the global gate even when customer-discovery voice is enabled", () => {
    render(<ResearchExperience token="study-token" studyName="Interview" studyType="CUSTOMER_INTERVIEW" appUrl={null} discoveryVoiceEnabled />)
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
