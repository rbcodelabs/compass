// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const resolveActiveResearchStudy = vi.hoisted(() => vi.fn())
const notFound = vi.hoisted(() => vi.fn(() => { throw new Error("NEXT_NOT_FOUND") }))
const artifactFindFirst = vi.hoisted(() => vi.fn())
const storageGet = vi.hoisted(() => vi.fn())

vi.mock("@/lib/research-access", () => ({ resolveActiveResearchStudy }))
vi.mock("next/navigation", () => ({ notFound }))
vi.mock("@/lib/db", () => ({ default: () => ({ artifact: { findFirst: artifactFindFirst } }) }))
vi.mock("@/lib/artifact-storage", () => ({ getArtifactStorage: () => ({ get: storageGet }) }))
vi.mock("@/components/research/research-experience", () => ({
  ResearchExperience: ({
    token,
    studyType,
    legacyVoiceEnabled,
    discoveryVoiceEnabled,
    artifactHtml,
  }: {
    token: string
    studyType: string
    legacyVoiceEnabled: boolean
    discoveryVoiceEnabled: boolean
    artifactHtml?: string | null
  }) => <div data-testid="research-experience">{token}:{studyType}:{String(legacyVoiceEnabled)}:{String(discoveryVoiceEnabled)}:{artifactHtml ? "has-artifact-html" : "no-artifact-html"}</div>,
}))

import ParticipantResearchPage from "@/app/research/[token]/page"

describe("participant research page", () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => { cleanup(); vi.unstubAllEnvs() })

  it("uses the centralized first-class participant-token resolver", async () => {
    resolveActiveResearchStudy.mockResolvedValue({
      study: { name: "Planning study", goal: "Understand planning", targetMinutes: 15, studyType: "CUSTOMER_INTERVIEW", appUrl: null, artifactId: null },
      participantToken: { id: "token-row-1" },
    })

    render(await ParticipantResearchPage({ params: Promise.resolve({ token: "new-raw-token" }) }))

    expect(resolveActiveResearchStudy).toHaveBeenCalledWith("new-raw-token")
    expect(screen.getByRole("heading", { name: "Planning study" })).toBeVisible()
    expect(screen.getByTestId("research-experience")).toHaveTextContent("new-raw-token:CUSTOMER_INTERVIEW:false:false:no-artifact-html")
    expect(artifactFindFirst).not.toHaveBeenCalled()
  })

  it("keeps legacy voice hidden in production even when both future voice gates are enabled", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("COMPASS_RESEARCH_AUTHORITATIVE_VOICE_ENABLED", "1")
    vi.stubEnv("COMPASS_RESEARCH_DISCOVERY_VOICE_ENABLED", "1")
    resolveActiveResearchStudy.mockResolvedValue({
      study: { name: "Planning study", goal: "Understand planning", targetMinutes: 15, studyType: "CUSTOMER_INTERVIEW", appUrl: null, artifactId: null },
      participantToken: { id: "token-row-1" },
    })

    render(await ParticipantResearchPage({ params: Promise.resolve({ token: "new-raw-token" }) }))

    expect(screen.getByTestId("research-experience")).toHaveTextContent("new-raw-token:CUSTOMER_INTERVIEW:false:true:no-artifact-html")
  })

  it("returns not found uniformly for an invalid, expired, or revoked token", async () => {
    resolveActiveResearchStudy.mockResolvedValue(null)

    await expect(ParticipantResearchPage({ params: Promise.resolve({ token: "invalid-token" }) }))
      .rejects.toThrow("NEXT_NOT_FOUND")
  })

  it("builds sandboxed artifact HTML server-side for an artifact-backed usability test and never exposes the artifact id", async () => {
    resolveActiveResearchStudy.mockResolvedValue({
      study: { name: "Prototype test", goal: "Understand the prototype", targetMinutes: 15, studyType: "USABILITY_TEST", appUrl: null, artifactId: "artifact-1" },
      participantToken: { id: "token-row-1" },
    })
    artifactFindFirst.mockResolvedValue({ id: "artifact-1", currentRevision: { blobPathname: "blobs/artifact-1" } })
    storageGet.mockResolvedValue(new TextEncoder().encode("<html><body>Prototype</body></html>"))

    render(await ParticipantResearchPage({ params: Promise.resolve({ token: "artifact-token" }) }))

    expect(artifactFindFirst.mock.calls[0][0].where).toMatchObject({ id: "artifact-1" })
    expect(storageGet).toHaveBeenCalledWith("blobs/artifact-1")
    expect(screen.getByTestId("research-experience")).toHaveTextContent("artifact-token:USABILITY_TEST:false:false:has-artifact-html")
  })

  it("degrades to no artifact HTML when the linked artifact or its blob is unavailable", async () => {
    resolveActiveResearchStudy.mockResolvedValue({
      study: { name: "Prototype test", goal: "Understand the prototype", targetMinutes: 15, studyType: "USABILITY_TEST", appUrl: null, artifactId: "artifact-missing" },
      participantToken: { id: "token-row-1" },
    })
    artifactFindFirst.mockResolvedValue(null)

    render(await ParticipantResearchPage({ params: Promise.resolve({ token: "artifact-token" }) }))

    expect(screen.getByTestId("research-experience")).toHaveTextContent("artifact-token:USABILITY_TEST:false:false:no-artifact-html")
  })
})
