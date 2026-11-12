// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({ get: vi.fn(), decide: vi.fn(), refresh: vi.fn() }))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/approvals/actions", () => ({ getApprovalCardAction: m.get, decideApprovalFromChatAction: m.decide }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: m.refresh, push: vi.fn() }) }))

import { ToolApprovalCard } from "@/components/tool-approval/approval-card"
import { AgentActivity } from "@/components/agent/agent-activity"
import { APPROVAL_STATES, type ApprovalStateKey } from "@/lib/tool-approval/state"
import type { ApprovalCardData } from "@/app/[orgSlug]/[workspaceSlug]/approvals/actions"

const WS = "22222222-2222-4222-8222-222222222222"
const REQ = "33333333-3333-4333-8333-333333333333"
const CONV = "44444444-4444-4444-8444-444444444444"

const data = (key: ApprovalStateKey, over: Partial<ApprovalCardData> = {}): ApprovalCardData => ({
  canDecide: true, effectWithheld: false,
  view: {
    requestId: REQ, displayId: "DEC-9", path: `/acme/product/approvals/${REQ}`, tool: "set_workspace_description", capabilityClass: "workspace.description",
    title: "Set description <i>now</i>", summary: "Changes the workspace description.", args: {}, before: { description: "old" }, after: { description: "new" },
    state: { key, ...APPROVAL_STATES[key] }, requestedBy: "agent", createdAt: "2026-11-09T10:00:00.000Z", expiresAt: null, decision: null, receipt: null,
  },
  ...over,
})
const mountCard = () => render(<ToolApprovalCard workspaceId={WS} requestId={REQ} conversationId={CONV} />)

const setHidden = (hidden: boolean) => Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden })
beforeEach(() => {
  vi.clearAllMocks()
  setHidden(false)
  vi.spyOn(Math, "random").mockReturnValue(0.5) // jitter factor exactly 1
  m.get.mockResolvedValue(data("PENDING"))
  m.decide.mockResolvedValue({ ok: true, tone: "success", message: "Approved. The action ran once." })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe("ToolApprovalCard", () => {
  it("fetches the stored request by id and workspace, then shows its title (as text), status and a compact diff", async () => {
    mountCard()
    expect(screen.getByTestId("tool-approval-card-loading")).toBeTruthy()
    await screen.findByTestId("tool-approval-card")
    expect(m.get).toHaveBeenCalledWith({ workspaceId: WS, requestId: REQ, conversationId: CONV })
    expect(screen.getByText("Set description <i>now</i>")).toBeTruthy()
    expect(document.querySelector("i")).toBeNull()
    expect(screen.getByTestId("approval-state").getAttribute("data-state")).toBe("PENDING")
    expect(screen.getByTestId("effect-diff")).toBeTruthy()
    expect(screen.getByText('"old"')).toBeTruthy()
    expect(screen.getByText('"new"')).toBeTruthy()
    expect((screen.getByTestId("approve-button") as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByTestId("deny-button") as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByRole("link", { name: "Open the full approval page" }).getAttribute("href")).toBe(`/acme/product/approvals/${REQ}`)
  })

  it("for a non-admin: disabled buttons with the reason, no effect, no link", async () => {
    m.get.mockResolvedValue(data("PENDING", { canDecide: false, effectWithheld: true }))
    mountCard()
    await screen.findByTestId("tool-approval-card")
    expect((screen.getByTestId("approve-button") as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId("deny-button") as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId("approval-disabled-reason").textContent).toMatch(/Only a workspace admin/)
    expect(screen.queryByTestId("effect-diff")).toBeNull()
    expect(screen.queryByRole("link", { name: "Open the full approval page" })).toBeNull()
  })

  it("renders nothing when the server returns nothing for that id (not a member, wrong workspace, forged id)", async () => {
    m.get.mockResolvedValue(null)
    const { container } = mountCard()
    await waitFor(() => expect(m.get).toHaveBeenCalled())
    await waitFor(() => expect(container.querySelector("[data-testid]")).toBeNull())
  })

  it.each((Object.keys(APPROVAL_STATES) as ApprovalStateKey[]).filter((k) => k !== "PENDING"))("%s: shows the status, explains it, and offers no buttons", async (key) => {
    m.get.mockResolvedValue(data(key))
    mountCard()
    await screen.findByTestId("tool-approval-card")
    expect(screen.getByTestId("approval-state").getAttribute("data-state")).toBe(key)
    expect(screen.getByText(APPROVAL_STATES[key].explanation)).toBeTruthy()
    expect(screen.queryByTestId("approve-button")).toBeNull()
    expect(screen.queryByTestId("deny-button")).toBeNull()
  })

  it("Approve calls the chat action once with the open workspace, request and conversation, reuses its key on a repeat, and reloads", async () => {
    mountCard()
    await screen.findByTestId("tool-approval-card")
    m.get.mockResolvedValue(data("APPLIED"))
    fireEvent.click(screen.getByTestId("approve-button"))
    await waitFor(() => expect(m.decide).toHaveBeenCalledTimes(1))
    expect(m.decide).toHaveBeenCalledWith({ workspaceId: WS, requestId: REQ, conversationId: CONV }, "APPROVE", expect.stringMatching(/^ta-[0-9a-f-]{36}$/))
    await waitFor(() => expect(screen.getByTestId("approval-result").textContent).toBe("Approved. The action ran once."))
    await waitFor(() => expect(screen.getByTestId("approval-state").getAttribute("data-state")).toBe("APPLIED"))
    expect(m.refresh).toHaveBeenCalled()
  })

  it("a double click while the request is in flight sends one decision", async () => {
    let finish!: (value: unknown) => void
    m.decide.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    mountCard()
    await screen.findByTestId("tool-approval-card")
    const approve = screen.getByTestId("approve-button")
    fireEvent.click(approve)
    fireEvent.click(approve)
    fireEvent.click(screen.getByTestId("deny-button"))
    await waitFor(() => expect(m.decide).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(m.decide).toHaveBeenCalledTimes(1)
    await act(async () => { finish({ ok: true, tone: "success", message: "done" }) })
  })

  it("Deny sends REJECT with a different key than Approve", async () => {
    mountCard()
    await screen.findByTestId("tool-approval-card")
    fireEvent.click(screen.getByTestId("deny-button"))
    await waitFor(() => expect(m.decide).toHaveBeenCalledTimes(1))
    expect(m.decide.mock.calls[0][1]).toBe("REJECT")
  })

  it("shows the action's refusal message in the card", async () => {
    m.decide.mockResolvedValue({ ok: false, tone: "danger", message: "Only a workspace admin can decide a tool approval." })
    mountCard()
    await screen.findByTestId("tool-approval-card")
    fireEvent.click(screen.getByTestId("approve-button"))
    expect(await screen.findByText("Only a workspace admin can decide a tool approval.")).toBeTruthy()
  })
})

describe("ToolApprovalCard: polling (A6)", () => {
  const mount = async () => {
    vi.useFakeTimers()
    mountCard()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  }
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

  it("polls every 4s while the state keeps changing and stops at a final state", async () => {
    m.get.mockResolvedValueOnce(data("PENDING")).mockResolvedValueOnce(data("APPLYING")).mockResolvedValue(data("APPLIED"))
    await mount()
    expect(m.get).toHaveBeenCalledTimes(1)
    await advance(4000)
    expect(m.get).toHaveBeenCalledTimes(2)
    await advance(4000)
    expect(m.get).toHaveBeenCalledTimes(3)
    expect(screen.getByTestId("approval-state").getAttribute("data-state")).toBe("APPLIED")
    await advance(120_000)
    expect(m.get).toHaveBeenCalledTimes(3)
  })

  it("backs off exponentially while nothing changes, capped at 30s", async () => {
    await mount()
    await advance(3999); expect(m.get).toHaveBeenCalledTimes(1)
    await advance(1); expect(m.get).toHaveBeenCalledTimes(2) // t=4s
    await advance(7999); expect(m.get).toHaveBeenCalledTimes(2)
    await advance(1); expect(m.get).toHaveBeenCalledTimes(3) // +8s
    await advance(15_999); expect(m.get).toHaveBeenCalledTimes(3)
    await advance(1); expect(m.get).toHaveBeenCalledTimes(4) // +16s
    await advance(29_999); expect(m.get).toHaveBeenCalledTimes(4)
    await advance(1); expect(m.get).toHaveBeenCalledTimes(5) // +30s (32s capped)
    await advance(30_000); expect(m.get).toHaveBeenCalledTimes(6) // stays at 30s
  })

  it("adds jitter of +/-20%", async () => {
    ;(Math.random as unknown as ReturnType<typeof vi.fn>).mockReturnValue(0)
    await mount()
    await advance(3199); expect(m.get).toHaveBeenCalledTimes(1)
    await advance(1); expect(m.get).toHaveBeenCalledTimes(2)
  })

  it("a change resets the backoff to 4s", async () => {
    m.get.mockResolvedValueOnce(data("PENDING")).mockResolvedValueOnce(data("PENDING")).mockResolvedValueOnce(data("APPLYING")).mockResolvedValue(data("APPLYING"))
    await mount()
    await advance(4000); expect(m.get).toHaveBeenCalledTimes(2) // same -> next in 8s
    await advance(8000); expect(m.get).toHaveBeenCalledTimes(3) // changed -> next in 4s
    await advance(4000); expect(m.get).toHaveBeenCalledTimes(4)
  })

  it("a failed poll keeps the last good card and backs off", async () => {
    m.get.mockResolvedValueOnce(data("PENDING")).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(data("PENDING"))
    await mount()
    await advance(4000); expect(m.get).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId("tool-approval-card")).toBeTruthy()
    await advance(7999); expect(m.get).toHaveBeenCalledTimes(2)
    await advance(1); expect(m.get).toHaveBeenCalledTimes(3)
  })

  it("pauses while the tab is hidden and refreshes at once when it returns", async () => {
    await mount()
    setHidden(true)
    await advance(10 * 60_000)
    expect(m.get).toHaveBeenCalledTimes(1) // the poll that fell due while hidden did not fetch, and nothing was rescheduled
    const before = m.get.mock.calls.length
    setHidden(false)
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(0) })
    expect(m.get).toHaveBeenCalledTimes(before + 1)
  })

  it("does not poll again after unmount", async () => {
    await mount()
    cleanup()
    await advance(120_000)
    expect(m.get).toHaveBeenCalledTimes(1)
  })
})

describe("ToolApprovalCard: fallbacks and review gate (A1, A3)", () => {
  it("shows an explicit fallback with a link when the action fails to load", async () => {
    m.get.mockRejectedValue(new Error("boom"))
    render(<ToolApprovalCard workspaceId={WS} requestId={REQ} conversationId={CONV} approvalsHref="/acme/product/approvals" />)
    const fallback = await screen.findByTestId("tool-approval-card-fallback")
    expect(fallback.textContent).toMatch(/could not load this approval/i)
    expect(within(fallback).getByRole("link").getAttribute("href")).toBe("/acme/product/approvals")
  })

  it("shows the fallback, not nothing, when rendering the diff throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const hostile = data("PENDING")
    hostile.view.before = { get boom(): never { throw new Error("cannot read") } } as never
    hostile.view.after = { boom: 1 } as never
    m.get.mockResolvedValue(hostile)
    render(<ToolApprovalCard workspaceId={WS} requestId={REQ} conversationId={CONV} approvalsHref="/acme/product/approvals" />)
    const fallback = await screen.findByTestId("tool-approval-card-fallback")
    expect(fallback.textContent).toMatch(/could not render/i)
    expect(within(fallback).getByRole("link").getAttribute("href")).toBe(`/acme/product/approvals/${REQ}`)
    log.mockRestore()
  })

  it("still renders nothing for an id the server does not know (forged)", async () => {
    m.get.mockResolvedValue(null)
    const { container } = mountCard()
    await waitFor(() => expect(m.get).toHaveBeenCalled())
    await waitFor(() => expect(container.querySelector("[data-testid]")).toBeNull())
  })

  it("disables Approve (Deny stays enabled) when changes are hidden, and links to the full details", async () => {
    const many = data("PENDING")
    many.view.before = {}
    many.view.after = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`k${i}`, i]))
    m.get.mockResolvedValue(many)
    mountCard()
    await screen.findByTestId("tool-approval-card")
    expect((screen.getByTestId("approve-button") as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId("deny-button") as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByTestId("approval-review-reason").textContent).toMatch(/not all changes are shown/i)
    expect(screen.getByTestId("approval-review-link").getAttribute("href")).toBe(`/acme/product/approvals/${REQ}`)
    // Said once: the notice is not a second "Review the full details" next to the link.
    expect(screen.getAllByText(/review the full details/i)).toHaveLength(1)
    expect(screen.getByTestId("approval-review-reason").textContent).not.toMatch(/review the full details/i)
  })

  it("disables Approve when the diff was cut off or the arguments are too long to show", async () => {
    const big = data("PENDING")
    big.view.args = { blob: "x".repeat(9000) }
    m.get.mockResolvedValue(big)
    mountCard()
    await screen.findByTestId("tool-approval-card")
    expect((screen.getByTestId("approve-button") as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId("deny-button") as HTMLButtonElement).disabled).toBe(false)
  })

  it("leaves Approve enabled when everything is shown, and shows the arguments in a collapsible", async () => {
    mountCard()
    await screen.findByTestId("tool-approval-card")
    expect((screen.getByTestId("approve-button") as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByRole("button", { name: /Call arguments/ })).toBeTruthy()
  })
})

describe("ToolApprovalCard: accessibility (A7)", () => {
  it("each card is a region labelled with its display id", async () => {
    mountCard()
    expect((await screen.findByRole("region", { name: "Tool approval DEC-9" })).getAttribute("data-testid")).toBe("tool-approval-card")
  })

  it("the live region is the same element before and after the buttons go away, and carries the outcome", async () => {
    mountCard()
    await screen.findByTestId("tool-approval-card")
    const live = screen.getByTestId("approval-result")
    expect(live.getAttribute("aria-live")).toBe("polite")
    m.get.mockResolvedValue(data("APPLIED"))
    fireEvent.click(screen.getByTestId("approve-button"))
    await waitFor(() => expect(screen.getByTestId("approval-state").getAttribute("data-state")).toBe("APPLIED"))
    expect(screen.queryByTestId("approve-button")).toBeNull()
    expect(screen.getByTestId("approval-result")).toBe(live)
    expect(live.textContent).toBe("Approved. The action ran once.")
  })

  it("moves focus to the outcome after a decision", async () => {
    mountCard()
    await screen.findByTestId("tool-approval-card")
    fireEvent.click(screen.getByTestId("deny-button"))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("approval-result")))
  })

  it("announces a state change the person did not cause", async () => {
    vi.useFakeTimers()
    m.get.mockResolvedValueOnce(data("PENDING")).mockResolvedValue(data("DENIED"))
    mountCard()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(screen.getByTestId("approval-result").textContent).toMatch(/DEC-9.*Denied/)
  })

  it("the full-page link is a client-side link with a 44px mobile target", async () => {
    mountCard()
    await screen.findByTestId("tool-approval-card")
    const link = screen.getByRole("link", { name: "Open the full approval page" })
    expect(link.className).toContain("min-h-11")
    expect(link.getAttribute("target")).toBeNull() // next/link navigates in-app, so the open chat is not reloaded
    expect(link.getAttribute("href")).toBe(`/acme/product/approvals/${REQ}`)
  })
})

describe("AgentActivity draws a card for APPROVAL_REQUIRED tool results", () => {
  const result = `Approval required. The action was NOT performed. Status: APPROVAL_REQUIRED ID: ${REQ} Display ID: DEC-9`
  const step = { id: "t1", label: "Set workspace description", status: "done" as const, result }

  it("draws one card per distinct request, in the activity strip, keyed by id", async () => {
    render(<AgentActivity toolCalls={[step, { ...step, id: "t2" }]} running={false} workspaceId={WS} conversationId={CONV} />)
    expect(await screen.findAllByTestId("tool-approval-card")).toHaveLength(1)
    expect(m.get).toHaveBeenCalledWith({ workspaceId: WS, requestId: REQ, conversationId: CONV })
  })

  it("also finds approvals inside a subagent's calls", async () => {
    render(<AgentActivity subagents={[{ id: "s", description: "d", agentType: "general", status: "done", steps: [step] }]} running={false} workspaceId={WS} />)
    expect(await screen.findByTestId("tool-approval-card")).toBeTruthy()
  })

  it("draws nothing for ordinary results, for a still-running call, or without a workspace", () => {
    render(<AgentActivity toolCalls={[{ id: "a", label: "Search", status: "done", result: "3 results" }, { ...step, id: "b", status: "running" }]} running workspaceId={WS} />)
    expect(m.get).not.toHaveBeenCalled()
    cleanup()
    render(<AgentActivity toolCalls={[step]} running={false} />)
    expect(m.get).not.toHaveBeenCalled()
  })
})
