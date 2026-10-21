// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const STUDY_UUID = "11111111-1111-4111-8111-111111111111"
const db = vi.hoisted(() => ({
  workspace: { findFirst: vi.fn() },
  researchStudy: { findFirst: vi.fn() },
  researchSession: { findFirst: vi.fn() },
  researchTurn: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
  researchAttachment: { findMany: vi.fn() },
}))
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "member-1" } }) }))
vi.mock("@/lib/db", () => ({ default: () => db }))
vi.mock("@/lib/research-feature", () => ({ isResearchCaptureEnabled: () => true }))
vi.mock("@/components/research/analysis-results", () => ({ SessionAnalysisResults: (props: { studyId: string; sessionUrl: string }) => <div data-testid="analysis" data-study-id={props.studyId} data-session-url={props.sessionUrl} /> }))
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND") },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`) },
  permanentRedirect: (to: string) => { throw new Error(`NEXT_PERMANENT_REDIRECT ${to}`) },
}))
import SessionPage from "@/app/[orgSlug]/[workspaceSlug]/capture/studies/[studyId]/sessions/[sessionId]/page"

const renderPage = async (studyId: string, searchParams: Record<string, string> = {}) =>
  render(await SessionPage({ params: Promise.resolve({ orgSlug: "org", workspaceSlug: "ws", studyId, sessionId: "sess-1" }), searchParams: Promise.resolve(searchParams) }))

beforeEach(() => {
  vi.clearAllMocks()
  db.workspace.findFirst.mockResolvedValue({ id: "workspace-1" })
  db.researchStudy.findFirst.mockResolvedValue({ id: STUDY_UUID, seqPrefix: "STUDY", seqNumber: 2 })
  db.researchSession.findFirst.mockResolvedValue({ modality: "CHAT", status: "COMPLETED", createdAt: new Date("2026-01-01"), study: { name: "Study", guide: "[]" }, _count: { turns: 0 } })
  db.researchTurn.findMany.mockResolvedValue([])
  db.researchAttachment.findMany.mockResolvedValue([])
})
afterEach(cleanup)

describe("research session page study segment", () => {
  it("resolves a display ID and queries by the study UUID with canonical links", async () => {
    await renderPage("STUDY-2")
    expect(db.researchStudy.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ seqPrefix: "STUDY", seqNumber: 2, workspaceId: "workspace-1" }) }))
    expect(db.researchSession.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "sess-1", studyId: STUDY_UUID }) }))
    expect(db.researchAttachment.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ studyId: STUDY_UUID }) }))
    expect(screen.getByRole("link", { name: "Back to study" })).toHaveAttribute("href", "/org/ws/capture/studies/STUDY-2")
    expect(screen.getByTestId("analysis")).toHaveAttribute("data-study-id", STUDY_UUID)
    expect(screen.getByTestId("analysis")).toHaveAttribute("data-session-url", "/org/ws/capture/studies/STUDY-2/sessions/sess-1")
  })

  it("308s a UUID URL to the canonical form keeping the sessions suffix and query", async () => {
    await expect(renderPage(STUDY_UUID, { page: "2", attachmentPage: "3", turnId: "t-1" }))
      .rejects.toThrow("NEXT_PERMANENT_REDIRECT /org/ws/capture/studies/STUDY-2/sessions/sess-1?page=2&attachmentPage=3&turnId=t-1")
    expect(db.researchSession.findFirst).not.toHaveBeenCalled()
  })

  it("404s an unknown or foreign study without touching sessions", async () => {
    db.researchStudy.findFirst.mockResolvedValue(null)
    await expect(renderPage("STUDY-99")).rejects.toThrow("NEXT_NOT_FOUND")
    expect(db.researchSession.findFirst).not.toHaveBeenCalled()
  })

  it("404s when the caller is not a workspace member", async () => {
    db.workspace.findFirst.mockResolvedValue(null)
    await expect(renderPage("STUDY-2")).rejects.toThrow("NEXT_NOT_FOUND")
    expect(db.researchStudy.findFirst).not.toHaveBeenCalled()
  })

  it("404s a session that belongs to a different study", async () => {
    db.researchSession.findFirst.mockResolvedValue(null)
    await expect(renderPage("STUDY-2")).rejects.toThrow("NEXT_NOT_FOUND")
    expect(db.researchSession.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "sess-1", studyId: STUDY_UUID }) }))
  })
})
