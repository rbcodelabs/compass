// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const auth = vi.hoisted(() => vi.fn())
const notFound = vi.hoisted(() => vi.fn(() => { throw new Error("NEXT_NOT_FOUND") }))
const redirect = vi.hoisted(() => vi.fn(() => { throw new Error("NEXT_REDIRECT") }))
const reconcileAbandonedResearchSessions = vi.hoisted(() => vi.fn())
const researchStudy = { findFirst: vi.fn(), findUnique: vi.fn() }
const researchParticipantToken = { findFirst: vi.fn() }

vi.mock("@/auth", () => ({ auth }))
vi.mock("next/navigation", () => ({ notFound, redirect }))
vi.mock("@/lib/db", () => ({ default: () => ({ researchStudy, researchParticipantToken }) }))
vi.mock("@/lib/research-session", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/research-session")>(),
  reconcileAbandonedResearchSessions,
}))

import StudyPage from "@/app/[orgSlug]/[workspaceSlug]/capture/studies/[studyId]/page"

const props = {
  params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "product", studyId: "study-1" }),
  searchParams: Promise.resolve({ token: "raw-token" }),
}

describe("researcher study access", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.mockResolvedValue({ user: { id: "user-1" } })
    reconcileAbandonedResearchSessions.mockResolvedValue({ count: 0 })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllEnvs()
  })

  it("returns not found before authentication when the production rollout gate is disabled", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("COMPASS_RESEARCH_CAPTURE_ENABLED", "")

    await expect(StudyPage(props)).rejects.toThrow("NEXT_NOT_FOUND")
    expect(auth).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  it("returns not found when the signed-in user is not a member of the path workspace", async () => {
    researchStudy.findFirst.mockResolvedValue(null)

    await expect(StudyPage(props)).rejects.toThrow("NEXT_NOT_FOUND")
    expect(researchStudy.findFirst).toHaveBeenCalledWith({
      where: {
        id: "study-1",
        workspace: {
          slug: "product",
          organization: { slug: "acme" },
          members: { some: { userId: "user-1" } },
        },
      },
      select: { id: true },
    })
    expect(researchStudy.findUnique).not.toHaveBeenCalled()
  })

  it("shows bounded canonical transcript history to a workspace member", async () => {
    researchStudy.findFirst.mockResolvedValue({ id: "study-1" })
    researchStudy.findUnique.mockResolvedValue({
      id: "study-1",
      name: "Planning interviews",
      goal: "Understand planning",
      participantTokens: [],
      sessions: [{
        id: "session-1",
        modality: "CHAT",
        status: "COMPLETED",
        turns: [
          { id: "turn-1", role: "INTERVIEWER", content: "Canonical question" },
          { id: "turn-2", role: "PARTICIPANT", content: "Canonical answer" },
        ],
      }],
    })
    researchParticipantToken.findFirst.mockResolvedValue(null)

    render(await StudyPage(props))

    expect(screen.getByText("Canonical question")).toBeVisible()
    expect(screen.getByText("Canonical answer")).toBeVisible()
    expect(reconcileAbandonedResearchSessions).toHaveBeenCalledWith(expect.anything(), "study-1")
    expect(researchStudy.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        sessions: expect.objectContaining({
          take: 50,
          include: { turns: { orderBy: { sequence: "asc" }, take: 200 } },
        }),
      }),
    }))
    expect(researchParticipantToken.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ studyId: "study-1" }),
    }))
  })
})
