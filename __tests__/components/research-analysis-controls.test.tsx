// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
const refresh = vi.fn()
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))
import { AnalysisButton } from "@/components/research/analysis-button"
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })
describe("research analysis controls", () => {
  it("shows model failure without hiding saved results", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "Analysis unavailable" }) }))
    render(<AnalysisButton studyId="study" sessionId="session" kind="summary">Generate summary</AnalysisButton>)
    fireEvent.click(screen.getByRole("button", { name: "Generate summary" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Analysis unavailable")
    expect(refresh).not.toHaveBeenCalled()
  })
  it("posts only identifiers and refreshes persisted results", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: {} }) })
    vi.stubGlobal("fetch", fetcher)
    render(<AnalysisButton studyId="study" sessionId="session" kind="coverage" regenerate>Recheck guide coverage</AnalysisButton>)
    fireEvent.click(screen.getByRole("button", { name: "Recheck guide coverage" }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ studyId: "study", sessionId: "session", kind: "coverage", regenerate: true })
  })
})
