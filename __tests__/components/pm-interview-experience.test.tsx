// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/components/research/research-voice", () => ({
  ResearchVoice: ({ onUseChat }: { onUseChat?: () => void }) => <button onClick={() => onUseChat?.()}>Microphone unavailable fallback</button>,
}))

import { PmInterviewExperience } from "@/components/research/pm-interview-experience"

const base = {
  interviewId: "00000000-0000-4000-8000-000000000001",
  orgSlug: "synthetic-org", workspaceSlug: "synthetic-workspace", targetType: "OPPORTUNITY" as const,
  targetTitle: "Clarify onboarding", omissions: [],
  initialTurns: [
    { id: "00000000-0000-4000-8000-000000000010", role: "INTERVIEWER", content: "Who experiences this?", sequence: 0 },
    { id: "00000000-0000-4000-8000-000000000011", role: "PARTICIPANT", content: "New workspace admins.", sequence: 1 },
    { id: "00000000-0000-4000-8000-000000000012", role: "INTERVIEWER", content: "What happens today?", sequence: 2 },
  ],
  initialProposal: { version: 1 as const, brief: "A safe brief", proposedFields: { title: { value: "Admins struggle to orient", transcriptTurnIds: ["00000000-0000-4000-8000-000000000011"] } }, openQuestions: [], suggestedNextSteps: [], unknowns: [] },
  initialDisposition: "APPLIED", initialGenerationState: "READY",
  initialReviewBaseline: { version: 1 as const, fields: { title: "Clarify onboarding" } },
  initialContextFields: { title: "Clarify onboarding" }, applicationDisabledReason: null,
  owner: false, voiceEnabled: true,
}

describe("PM interview member history", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it("enters chat without settling a lease when microphone access failed before voice startup", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    render(<PmInterviewExperience {...base} initialTurns={[]} initialProposal={null} initialDisposition="PENDING" initialReceipt={null} owner />)
    fireEvent.click(screen.getByRole("button", { name: /Start voice/ }))
    fireEvent.click(screen.getByRole("button", { name: "Microphone unavailable fallback" }))
    await waitFor(() => expect(screen.getByLabelText("Your answer")).toBeVisible())
    expect(fetch).not.toHaveBeenCalled()
  })

  it("shows the complete transcript and safe applied receipt after proposal generation", () => {
    render(<PmInterviewExperience {...base} initialReceipt={{ version: 1, kind: "APPLIED", selectedFields: ["title"], before: { title: "Clarify onboarding" }, after: { title: "Admins struggle to orient" }, at: "2026-09-11T12:05:00.000Z" }} />)
    expect(screen.getByText("Who experiences this?")).toBeVisible()
    expect(screen.getByText("New workspace admins.")).toBeVisible()
    expect(screen.getByText("What happens today?")).toBeVisible()
    expect(screen.getByText(/Clarify onboarding → Admins struggle to orient/)).toBeVisible()
    expect(screen.queryByRole("button", { name: "Apply selected changes" })).not.toBeInTheDocument()
  })

  it("shows a safe dismissal receipt without inventing field changes", () => {
    render(<PmInterviewExperience {...base} initialDisposition="DISMISSED" initialReceipt={{ version: 1, kind: "DISMISSED", at: "2026-09-11T12:05:00.000Z" }} />)
    expect(screen.getByText(/Dismissed without applying changes/)).toBeVisible()
    expect(screen.queryByText(/Clarify onboarding →/)).not.toBeInTheDocument()
  })
})
