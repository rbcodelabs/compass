// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
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

beforeEach(() => { vi.clearAllMocks(); m.get.mockResolvedValue(data("PENDING")); m.decide.mockResolvedValue({ ok: true, tone: "success", message: "Approved. The action ran once." }) })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe("ToolApprovalCard", () => {
  it("fetches the stored request by id and workspace, then shows its title (as text), status and a compact diff", async () => {
    mountCard()
    expect(screen.getByTestId("tool-approval-card-loading")).toBeTruthy()
    await screen.findByTestId("tool-approval-card")
    expect(m.get).toHaveBeenCalledWith({ workspaceId: WS, requestId: REQ })
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

  it("polls while the approval is open and stops once it is terminal", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    m.get.mockResolvedValueOnce(data("PENDING")).mockResolvedValueOnce(data("APPLYING")).mockResolvedValue(data("APPLIED"))
    mountCard()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(m.get).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(4100) })
    expect(m.get).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(4100) })
    expect(m.get).toHaveBeenCalledTimes(3)
    expect(screen.getByTestId("approval-state").getAttribute("data-state")).toBe("APPLIED")
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(m.get).toHaveBeenCalledTimes(3)
  })

  it("Approve calls the chat action once with the open workspace, request and conversation, reuses its key on a repeat, and reloads", async () => {
    mountCard()
    await screen.findByTestId("tool-approval-card")
    m.get.mockResolvedValue(data("APPLIED"))
    fireEvent.click(screen.getByTestId("approve-button"))
    await waitFor(() => expect(m.decide).toHaveBeenCalledTimes(1))
    expect(m.decide).toHaveBeenCalledWith({ workspaceId: WS, requestId: REQ, conversationId: CONV }, "APPROVE", expect.stringMatching(/^ta-[0-9a-f-]{36}$/))
    await screen.findByText("Approved. The action ran once.")
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

describe("AgentActivity draws a card for APPROVAL_REQUIRED tool results", () => {
  const result = `Approval required. The action was NOT performed. Status: APPROVAL_REQUIRED ID: ${REQ} Display ID: DEC-9`
  const step = { id: "t1", label: "Set workspace description", status: "done" as const, result }

  it("draws one card per distinct request, in the activity strip, keyed by id", async () => {
    render(<AgentActivity toolCalls={[step, { ...step, id: "t2" }]} running={false} workspaceId={WS} conversationId={CONV} />)
    expect(await screen.findAllByTestId("tool-approval-card")).toHaveLength(1)
    expect(m.get).toHaveBeenCalledWith({ workspaceId: WS, requestId: REQ })
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
