// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  researchSession: { findFirst: vi.fn() },
  researchTurn: { findMany: vi.fn() },
  researchAttachment: { findMany: vi.fn() },
}))
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "member-1" } }) }))
vi.mock("@/lib/db", () => ({ default: () => db }))
vi.mock("@/lib/research-feature", () => ({ isResearchCaptureEnabled: () => true }))
vi.mock("@/components/research/analysis-results", () => ({ SessionAnalysisResults: () => null }))
import SessionPage from "@/app/[orgSlug]/[workspaceSlug]/capture/studies/[studyId]/sessions/[sessionId]/page"

afterEach(cleanup)
it("keeps private original downloads available for HEIC and failed GIF previews in session results", async () => {
  db.researchSession.findFirst.mockResolvedValue({ modality: "CHAT", status: "COMPLETED", createdAt: new Date("2026-01-01"), study: { name: "Study", guide: "[]" }, _count: { turns: 0 } })
  db.researchTurn.findMany.mockResolvedValue([])
  db.researchAttachment.findMany.mockResolvedValue([
    { id: "heic-1", originalName: "photo.heic", mimeType: "image/heic" },
    { id: "gif-1", originalName: "recording.gif", mimeType: "image/gif" },
  ])
  render(await SessionPage({ params: Promise.resolve({ orgSlug: "org", workspaceSlug: "workspace", studyId: "study", sessionId: "session" }), searchParams: Promise.resolve({}) }))
  expect(screen.getByRole("link", { name: "photo.heic" })).toHaveAttribute("download", "photo.heic")
  expect(screen.getByRole("link", { name: "photo.heic" })).toHaveAttribute("href", "/api/research/member-attachments/heic-1")
  expect(screen.getByText(/HEIC is preserved for researchers/)).toBeVisible()
  expect(screen.queryByRole("img", { name: "photo.heic" })).not.toBeInTheDocument()
  fireEvent.error(screen.getByRole("img", { name: "recording.gif" }))
  expect(screen.getByText(/Preview unavailable/)).toBeVisible()
  expect(screen.getByRole("link", { name: "recording.gif" })).toHaveAttribute("download", "recording.gif")
  expect(db.researchSession.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "session", studyId: "study", study: { workspace: { slug: "workspace", organization: { slug: "org" }, members: { some: { userId: "member-1" } } } } }) }))
})
