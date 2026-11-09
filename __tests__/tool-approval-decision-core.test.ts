import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  isAdmin: vi.fn(),
  decide: vi.fn(),
  loadView: vi.fn(),
  addUpdate: vi.fn(),
}))
vi.mock("@/lib/db", () => ({ default: () => ({}) }))
vi.mock("@/lib/agent-ownership", () => ({ isWorkspaceAdminUser: m.isAdmin }))
vi.mock("@/lib/tool-approval/decide", () => ({ decideToolApproval: m.decide }))
vi.mock("@/lib/tool-approval/conversation", () => ({ addApprovalUpdateToConversation: m.addUpdate }))
vi.mock("@/lib/tool-approval/view", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tool-approval/view")>()), loadApprovalView: m.loadView }))

import { runApprovalDecision } from "@/app/[orgSlug]/[workspaceSlug]/approvals/decision-core"
import { ToolApprovalError } from "@/lib/tool-approval/errors"

const USER = "11111111-1111-4111-8111-111111111111"
const WS = "22222222-2222-4222-8222-222222222222"
const REQ = "33333333-3333-4333-8333-333333333333"
const CONV = "44444444-4444-4444-8444-444444444444"
const SUBMISSION = `ta-${"0123456789abcdef".repeat(2)}`
const input = (over: Record<string, unknown> = {}) => ({ userId: USER, workspaceId: WS, requestId: REQ, action: "APPROVE" as const, idempotencyKey: SUBMISSION, ...over })
const view = (key: string) => ({ requestId: REQ, displayId: "DEC-2", tool: "set_workspace_description", state: { key } })

class FakeDecisionError extends Error {
  constructor(public readonly code: string) { super(`secret internal detail for ${code}`); this.name = "DecisionError" }
}

beforeEach(() => {
  vi.clearAllMocks()
  m.isAdmin.mockResolvedValue(true)
  m.loadView.mockResolvedValue(view("PENDING"))
  m.decide.mockResolvedValue({ decision: { id: "d1" }, execution: { status: "EXECUTED", receiptId: "r1", result: { updated: true } } })
  m.addUpdate.mockResolvedValue("added")
})

describe("runApprovalDecision: who may act on what", () => {
  it("refuses a non-admin before touching the request or the decision service", async () => {
    m.isAdmin.mockResolvedValue(false)
    const r = await runApprovalDecision(input())
    expect(r).toMatchObject({ ok: false })
    expect(r.message).toMatch(/workspace admin/)
    expect(m.isAdmin).toHaveBeenCalledWith(expect.anything(), USER, WS)
    expect(m.loadView).not.toHaveBeenCalled()
    expect(m.decide).not.toHaveBeenCalled()
  })

  it("refuses a request id that is not in the named workspace (IDOR), without deciding", async () => {
    m.loadView.mockResolvedValue(null)
    const r = await runApprovalDecision(input())
    expect(r).toMatchObject({ ok: false })
    expect(m.loadView).toHaveBeenCalledWith(expect.anything(), { requestId: REQ, workspaceId: WS })
    expect(m.decide).not.toHaveBeenCalled()
  })

  it.each([
    ["a non-uuid user", { userId: "x" }],
    ["a non-uuid workspace", { workspaceId: "../etc" }],
    ["a non-uuid request", { requestId: "DEC-1" }],
    ["an unknown action", { action: "SHIP_IT" }],
    ["an empty key", { idempotencyKey: "" }],
    ["a key with odd characters", { idempotencyKey: "ta-0123456789abcdef; drop table" }],
    ["a key that is too long", { idempotencyKey: "k".repeat(101) }],
  ])("rejects %s without any lookup", async (_name, over) => {
    const r = await runApprovalDecision(input(over))
    expect(r.ok).toBe(false)
    expect(m.isAdmin).not.toHaveBeenCalled()
    expect(m.decide).not.toHaveBeenCalled()
  })
})

describe("runApprovalDecision: approve and deny", () => {
  it("admin approve calls decideToolApproval once, as the given user, and reports the applied state", async () => {
    m.loadView.mockResolvedValueOnce(view("PENDING")).mockResolvedValueOnce(view("APPLIED"))
    const r = await runApprovalDecision(input())
    expect(m.decide).toHaveBeenCalledTimes(1)
    expect(m.decide).toHaveBeenCalledWith({ requestId: REQ, optionActionKey: "APPROVE", actingUserId: USER, idempotencyKey: SUBMISSION })
    expect(r).toMatchObject({ ok: true, tone: "success", state: "APPLIED" })
  })

  it("replaying the same key reaches the decision service with that same key and reports it was not run again", async () => {
    m.decide.mockResolvedValue({ decision: { id: "d1" }, execution: { status: "ALREADY_APPLIED", receiptStatus: "APPLIED" } })
    const first = await runApprovalDecision(input())
    const second = await runApprovalDecision(input())
    expect(m.decide.mock.calls.map((c) => c[0].idempotencyKey)).toEqual([SUBMISSION, SUBMISSION])
    expect(first.message).toMatch(/not run again/)
    expect(second.message).toMatch(/not run again/)
  })

  it("deny sends REJECT and reports denial; no executor outcome is consulted", async () => {
    m.decide.mockResolvedValue({ decision: { id: "d1" }, execution: null })
    m.loadView.mockResolvedValueOnce(view("PENDING")).mockResolvedValueOnce(view("DENIED"))
    const r = await runApprovalDecision(input({ action: "REJECT" }))
    expect(m.decide).toHaveBeenCalledWith(expect.objectContaining({ optionActionKey: "REJECT" }))
    expect(r).toMatchObject({ ok: true, state: "DENIED" })
    expect(r.message).toMatch(/not performed/)
  })

  it("a deny never reports an execution even if the service returned one", async () => {
    m.decide.mockResolvedValue({ decision: { id: "d1" }, execution: { status: "EXECUTED", receiptId: "r", result: null } })
    const r = await runApprovalDecision(input({ action: "REJECT" }))
    expect(r.message).toMatch(/Denied/)
  })

  it.each([
    [{ status: "FAILED", receiptId: "r", error: "Error: boom" }, "FAILED", /failed/],
    [{ status: "STALE", receiptId: "r" }, "STALE", /moved after it was reviewed/],
    [{ status: "BLOCKED", receiptId: "r", floors: ["limit"] }, "BLOCKED", /limit/],
    [{ status: "UNKNOWN_OUTCOME", receiptStatus: "PENDING", needsOperator: true }, "UNKNOWN_OUTCOME", /operator/],
    [{ status: "REFUSED", reason: "APPROVER_NOT_ADMIN_NOW" }, "NOT_RUN", /no longer a workspace admin/],
    [{ status: "REFUSED", reason: "TOOL_NOT_REGISTERED" }, "NOT_RUN", /not available for approval/],
  ])("maps executor outcome %j to a readable message", async (execution, state, pattern) => {
    m.decide.mockResolvedValue({ decision: { id: "d1" }, execution })
    // The state reported back is the stored one, read after the attempt.
    m.loadView.mockResolvedValueOnce(view("PENDING")).mockResolvedValue(view(state))
    const r = await runApprovalDecision(input())
    expect(r.ok).toBe(false)
    expect(r.state).toBe(state)
    expect(r.message).toMatch(pattern)
  })
})

describe("runApprovalDecision: errors", () => {
  it("maps a DecisionError code to our wording and never leaks the raw message", async () => {
    m.decide.mockRejectedValue(new FakeDecisionError("REVISION_NOT_PENDING"))
    const r = await runApprovalDecision(input())
    expect(r).toMatchObject({ ok: false })
    expect(r.message).toMatch(/already been decided or closed/)
    expect(r.message).not.toMatch(/secret internal detail/)
  })

  it("maps a ToolApprovalError code", async () => {
    m.decide.mockRejectedValue(new ToolApprovalError("REQUEST_NOT_FOUND", "internal"))
    expect((await runApprovalDecision(input())).message).toMatch(/could not be found/)
  })

  it("an unexpected error becomes a generic message and logs only the error class", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
    m.decide.mockRejectedValue(new Error("connection string postgres://user:pw@host/db"))
    const r = await runApprovalDecision(input())
    expect(r.ok).toBe(false)
    expect(r.message).not.toMatch(/postgres|pw@/)
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/postgres|pw@/)
    log.mockRestore()
  })
})

describe("runApprovalDecision: telling the conversation", () => {
  it("adds the outcome to the named conversation from the stored state", async () => {
    m.loadView.mockResolvedValueOnce(view("PENDING")).mockResolvedValueOnce(view("APPLIED"))
    await runApprovalDecision(input({ conversationId: CONV }))
    expect(m.addUpdate).toHaveBeenCalledTimes(1)
    expect(m.addUpdate).toHaveBeenCalledWith(expect.anything(), { conversationId: CONV, workspaceId: WS, userId: USER, view: expect.objectContaining({ state: { key: "APPLIED" } }) })
  })

  it("does not tell the conversation while the request is still pending (a refused click) or when none is named or the id is bad", async () => {
    m.decide.mockRejectedValue(new FakeDecisionError("ADMIN_REQUIRED"))
    await runApprovalDecision(input({ conversationId: CONV }))
    expect(m.addUpdate).not.toHaveBeenCalled()
    m.decide.mockResolvedValue({ decision: { id: "d" }, execution: null })
    m.loadView.mockResolvedValue(view("DENIED"))
    await runApprovalDecision(input({ action: "REJECT" }))
    await runApprovalDecision(input({ action: "REJECT", conversationId: "not-a-uuid" }))
    expect(m.addUpdate).not.toHaveBeenCalled()
  })

  it("a failure to write the conversation message does not turn a recorded decision into an error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
    m.loadView.mockResolvedValueOnce(view("PENDING")).mockResolvedValue(view("APPLIED"))
    m.addUpdate.mockRejectedValue(new Error("db down"))
    const r = await runApprovalDecision(input({ conversationId: CONV }))
    expect(r.ok).toBe(true)
    log.mockRestore()
  })
})
