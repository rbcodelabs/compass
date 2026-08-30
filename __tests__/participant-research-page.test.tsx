// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const resolveActiveResearchStudy = vi.hoisted(() => vi.fn())
const notFound = vi.hoisted(() => vi.fn(() => { throw new Error("NEXT_NOT_FOUND") }))

vi.mock("@/lib/research-access", () => ({ resolveActiveResearchStudy }))
vi.mock("next/navigation", () => ({ notFound }))
vi.mock("@/components/research/research-experience", () => ({
  ResearchExperience: ({ token, studyType }: { token: string; studyType: string }) => <div data-testid="research-experience">{token}:{studyType}</div>,
}))

import ParticipantResearchPage from "@/app/research/[token]/page"

describe("participant research page", () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)

  it("uses the centralized first-class participant-token resolver", async () => {
    resolveActiveResearchStudy.mockResolvedValue({
      study: { name: "Planning study", goal: "Understand planning", targetMinutes: 15, studyType: "CUSTOMER_INTERVIEW", appUrl: null },
      participantToken: { id: "token-row-1" },
    })

    render(await ParticipantResearchPage({ params: Promise.resolve({ token: "new-raw-token" }) }))

    expect(resolveActiveResearchStudy).toHaveBeenCalledWith("new-raw-token")
    expect(screen.getByRole("heading", { name: "Planning study" })).toBeVisible()
    expect(screen.getByTestId("research-experience")).toHaveTextContent("new-raw-token:CUSTOMER_INTERVIEW")
  })

  it("returns not found uniformly for an invalid, expired, or revoked token", async () => {
    resolveActiveResearchStudy.mockResolvedValue(null)

    await expect(ParticipantResearchPage({ params: Promise.resolve({ token: "invalid-token" }) }))
      .rejects.toThrow("NEXT_NOT_FOUND")
  })
})
