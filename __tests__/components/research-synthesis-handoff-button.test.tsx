// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
const push = vi.fn()
const refresh = vi.fn()
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }))
import { SynthesisHandoffButton } from "@/components/research/analysis-button"
import { SynthesisResults } from "@/components/research/analysis-results"

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

describe("synthesis handoff button", () => {
  it("opens the linked conversation instead of awaiting a standalone pipeline", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ conversationId: "conversation-1", conversationUrl: "/acme/product/agent?c=conversation-1" }) })
    vi.stubGlobal("fetch", fetcher)
    render(<SynthesisHandoffButton studyId="study">Generate synthesis</SynthesisHandoffButton>)
    fireEvent.click(screen.getByRole("button", { name: "Generate synthesis" }))
    await waitFor(() => expect(push).toHaveBeenCalledWith("/acme/product/agent?c=conversation-1"))
    expect(fetcher.mock.calls[0][0]).toBe("/api/research/synthesis-handoff")
    // Only the identifier is posted — no transcripts, no slugs to trust.
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ studyId: "study" })
    expect(refresh).not.toHaveBeenCalled()
  })

  it("shows the server's reason and navigates nowhere on failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "Study not found" }) }))
    render(<SynthesisHandoffButton studyId="study">Generate synthesis</SynthesisHandoffButton>)
    fireEvent.click(screen.getByRole("button", { name: "Generate synthesis" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Study not found")
    expect(push).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Generate synthesis" })).toBeEnabled()
  })

  it("does not fire a second conversation on a double click", async () => {
    const fetcher = vi.fn(() => new Promise(() => {}))
    vi.stubGlobal("fetch", fetcher)
    render(<SynthesisHandoffButton studyId="study">Generate synthesis</SynthesisHandoffButton>)
    const button = screen.getByRole("button", { name: "Generate synthesis" })
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByRole("button", { name: "Opening synthesis conversation…" })).toBeDisabled())
    fireEvent.click(screen.getByRole("button", { name: "Opening synthesis conversation…" }))
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe("synthesis history view", () => {
  const stored = JSON.stringify({
    version: 1, kind: "synthesis", generatedAt: "2026-09-14T00:00:00.000Z", sourceFingerprint: "a".repeat(64), sourceSessionIds: ["s1"], guideFingerprint: "b".repeat(64), model: "claude-sonnet-5", promptVersion: "research-analysis-v1",
    summary: "Planning friction dominates.",
    themes: [{ title: "Slow planning", description: "Time cost recurs.", surprising: true, quotes: [{ sessionId: "s1", turnId: "t1", text: "takes hours" }] }],
    patterns: [], jobs: [], recommendations: [],
  })

  it("still renders stored snapshots alongside the new handoff action", () => {
    render(<SynthesisResults snapshots={[{ id: "snapshot-1", content: stored, sessionCount: 2, createdAt: new Date("2026-09-14T00:00:00Z") }]} studyId="study" studyUrl="/acme/product/capture/studies/study" completedSessionIds={["s1"]} currentGuideFingerprint={"b".repeat(64)} />)
    expect(screen.getByRole("button", { name: "Regenerate synthesis" })).toBeInTheDocument()
    expect(screen.getByText("Planning friction dominates.")).toBeInTheDocument()
    expect(screen.getByText("Slow planning · Surprising finding")).toBeInTheDocument()
    expect(screen.getByText("“takes hours”")).toBeInTheDocument()
  })

  it("routes the synthesis action through the handoff endpoint, not /api/research/analysis", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ conversationId: "c1", conversationUrl: "/acme/product/agent?c=c1" }) })
    vi.stubGlobal("fetch", fetcher)
    render(<SynthesisResults snapshots={[]} studyId="study" studyUrl="/acme/product/capture/studies/study" completedSessionIds={[]} currentGuideFingerprint={"b".repeat(64)} />)
    fireEvent.click(screen.getByRole("button", { name: "Generate synthesis" }))
    await waitFor(() => expect(push).toHaveBeenCalled())
    expect(fetcher.mock.calls[0][0]).toBe("/api/research/synthesis-handoff")
  })
})
