import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({ isAdmin: vi.fn() }))
vi.mock("@/lib/agent-ownership", () => ({ isWorkspaceAdminUser: m.isAdmin }))

import { loadApprovalRequester, loadApprovalView, loadRecentApprovals, RECENT_APPROVALS_LIMIT } from "@/lib/tool-approval/view"
import { EFFECT_PACKET_SCHEMA_VERSION, fingerprintOf } from "@/lib/tool-approval/packet"
import { setToolApprovalRegistryForTest, type ToolApprovalSpec } from "@/lib/tool-approval/registry"

const WS = "22222222-2222-4222-8222-222222222222"
const REQ = "33333333-3333-4333-8333-333333333333"
const NOW = new Date("2026-11-09T12:00:00Z")
const packet = { schemaVersion: EFFECT_PACKET_SCHEMA_VERSION, tool: "set_workspace_description", capabilityClass: "workspace.description", workspaceId: WS, args: { workspaceId: WS, description: "new" }, before: "old", after: "new" }

const spec: ToolApprovalSpec = { toolName: "set_workspace_description", capabilityClass: "workspace.description", describe: () => ({ title: "t", summary: "s" }), readBefore: () => null, computeAfter: () => null, execute: async () => null }

function row(over: Record<string, unknown> = {}, revision: Record<string, unknown> = {}) {
  return {
    id: REQ, workspaceId: WS, decisionCycle: 1, seqPrefix: null, seqNumber: 12, state: "PENDING", requestedById: null, requestedByAgentId: "agent-1", createdAt: new Date("2026-11-09T10:00:00Z"),
    workspace: { slug: "product", organization: { slug: "acme" } },
    currentRevision: { revisionNumber: 1, fingerprint: fingerprintOf(REQ, 1, 1, packet), title: "Set description", summary: "S", packetJson: JSON.stringify(packet), supersededAt: null, expiresAt: new Date("2026-11-10T10:00:00Z"), decisions: [], ...revision },
    ...over,
  }
}
const decided = (outcomeClass: string, application: Record<string, unknown> | null) => ({
  actorUserId: "admin-1", decidedAt: new Date("2026-11-09T11:00:00Z"), option: { outcomeClass },
  applications: application ? [{ status: "APPLIED", updatedAt: new Date("2026-11-09T11:00:01Z"), appliedAt: new Date("2026-11-09T11:00:01Z"), lastError: null, ...application }] : [],
})

let prisma: { reviewRequest: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> }; user: { findMany: ReturnType<typeof vi.fn> } }
afterEach(() => setToolApprovalRegistryForTest(null))
beforeEach(() => {
  setToolApprovalRegistryForTest({ [spec.toolName]: spec })
  m.isAdmin.mockReset()
  m.isAdmin.mockResolvedValue(true)
  prisma = { reviewRequest: { findFirst: vi.fn().mockResolvedValue(row()), findMany: vi.fn().mockResolvedValue([row()]) }, user: { findMany: vi.fn().mockResolvedValue([{ id: "admin-1", name: "Ada Admin", email: "ada@example.com" }]) } }
})

describe("loadApprovalView", () => {
  it("scopes by request id, workspace AND the tool-approval gate, so an id alone never selects a row", async () => {
    await loadApprovalView(prisma as never, { requestId: REQ, workspaceId: WS, now: NOW })
    expect(prisma.reviewRequest.findFirst.mock.calls[0][0].where).toEqual({ id: REQ, workspaceId: WS, gateType: "TOOL_APPROVAL" })
  })

  it("returns null without querying for a malformed id", async () => {
    expect(await loadApprovalView(prisma as never, { requestId: "DEC-1", workspaceId: WS })).toBeNull()
    expect(await loadApprovalView(prisma as never, { requestId: REQ, workspaceId: "x" })).toBeNull()
    expect(prisma.reviewRequest.findFirst).not.toHaveBeenCalled()
  })

  it("returns null when nothing matches (another workspace, another gate) or the stored packet is unreadable", async () => {
    prisma.reviewRequest.findFirst.mockResolvedValue(null)
    expect(await loadApprovalView(prisma as never, { requestId: REQ, workspaceId: WS })).toBeNull()
    prisma.reviewRequest.findFirst.mockResolvedValue(row({}, { packetJson: "{not json" }))
    expect(await loadApprovalView(prisma as never, { requestId: REQ, workspaceId: WS })).toBeNull()
  })

  it("reads title, summary, tool, effect and args from the stored revision and packet", async () => {
    const v = (await loadApprovalView(prisma as never, { requestId: REQ, workspaceId: WS, now: NOW }))!
    expect(v).toMatchObject({
      requestId: REQ, displayId: "DEC-12", path: `/acme/product/approvals/${REQ}`, title: "Set description", summary: "S", tool: "set_workspace_description",
      capabilityClass: "workspace.description", before: "old", after: "new", args: { workspaceId: WS, description: "new" }, requestedBy: "agent", decision: null, receipt: null,
      expiresAt: "2026-11-10T10:00:00.000Z",
    })
    expect(v.state.key).toBe("PENDING")
  })

  it("maps a stored decision plus executor receipt to the state, the decider's name and the receipt", async () => {
    prisma.reviewRequest.findFirst.mockResolvedValue(row({ state: "DECIDED" }, { decisions: [decided("APPROVE", { status: "APPLIED" })] }))
    const v = (await loadApprovalView(prisma as never, { requestId: REQ, workspaceId: WS, now: NOW }))!
    expect(v.state.key).toBe("APPLIED")
    expect(v.decision).toEqual({ approved: true, decidedAt: "2026-11-09T11:00:00.000Z", decidedByName: "Ada Admin" })
    expect(v.receipt).toEqual({ status: "APPLIED", appliedAt: "2026-11-09T11:00:01.000Z", error: null })
  })

  it("a denial has no receipt and reads as denied", async () => {
    prisma.reviewRequest.findFirst.mockResolvedValue(row({ state: "DECIDED" }, { decisions: [decided("REJECT", null)] }))
    const v = (await loadApprovalView(prisma as never, { requestId: REQ, workspaceId: WS, now: NOW }))!
    expect(v.state.key).toBe("DENIED")
    expect(v.decision?.approved).toBe(false)
  })

  it("sanitises a stored receipt error again before it can be shown", async () => {
    prisma.reviewRequest.findFirst.mockResolvedValue(row({ state: "DECIDED" }, { decisions: [decided("APPROVE", { status: "FAILED", lastError: "Error: x Bearer sk-live-abcdefghijklmnopqrstuvwxyz0123456789\nat /srv/app.ts:12" })] }))
    const v = (await loadApprovalView(prisma as never, { requestId: REQ, workspaceId: WS, now: NOW }))!
    expect(v.state.key).toBe("FAILED")
    expect(v.receipt?.error).not.toMatch(/sk-live|srv\/app|\n/)
  })

  it.each([
    ["expired and undecided", row({}, { expiresAt: new Date("2026-11-09T11:00:00Z") }), "EXPIRED"],
    ["superseded", row({ state: "SUPERSEDED" }), "SUPERSEDED"],
    ["a pending receipt that went quiet", row({ state: "DECIDED" }, { decisions: [decided("APPROVE", { status: "PENDING", updatedAt: new Date("2026-11-09T11:00:01Z") })] }), "UNKNOWN_OUTCOME"],
    ["stale", row({ state: "DECIDED" }, { decisions: [decided("APPROVE", { status: "STALE" })] }), "STALE"],
  ])("%s", async (_name, found, expected) => {
    prisma.reviewRequest.findFirst.mockResolvedValue(found)
    expect((await loadApprovalView(prisma as never, { requestId: REQ, workspaceId: WS, now: NOW }))!.state.key).toBe(expected)
  })

  it("labels who asked without exposing ids", async () => {
    prisma.reviewRequest.findFirst.mockResolvedValue(row({ requestedByAgentId: null, requestedById: "u" }))
    expect((await loadApprovalView(prisma as never, { requestId: REQ, workspaceId: WS, now: NOW }))!.requestedBy).toBe("person")
    prisma.reviewRequest.findFirst.mockResolvedValue(row({ requestedByAgentId: null, requestedById: null }))
    expect((await loadApprovalView(prisma as never, { requestId: REQ, workspaceId: WS, now: NOW }))!.requestedBy).toBe("service")
  })
})

describe("an approval the executor would refuse never reads as running (B1)", () => {
  const approvedNoReceipt = (over: Record<string, unknown> = {}, revision: Record<string, unknown> = {}) =>
    row({ state: "DECIDED", ...over }, { decisions: [{ ...decided("APPROVE", null), decidedAt: new Date(NOW.getTime() - 500) }], ...revision })
  const stateOf = async () => (await loadApprovalView(prisma as never, { requestId: REQ, workspaceId: WS, now: NOW }))!.state.key

  it("reads APPLYING only when the executor could still claim it (registered, intact, approver still admin, in time)", async () => {
    prisma.reviewRequest.findFirst.mockResolvedValue(approvedNoReceipt())
    expect(await stateOf()).toBe("APPLYING")
  })
  it("a demoted approver: Approved, not run", async () => {
    prisma.reviewRequest.findFirst.mockResolvedValue(approvedNoReceipt())
    m.isAdmin.mockResolvedValue(false)
    expect(await stateOf()).toBe("NOT_RUN")
    expect(m.isAdmin).toHaveBeenCalledWith(expect.anything(), "admin-1", WS)
  })
  it("a tool whose capability class changed since the request: Approved, not run", async () => {
    prisma.reviewRequest.findFirst.mockResolvedValue(approvedNoReceipt())
    setToolApprovalRegistryForTest({ [spec.toolName]: { ...spec, capabilityClass: "something.else" } })
    expect(await stateOf()).toBe("NOT_RUN")
  })
  it("a tool that is no longer registered: Approved, not run", async () => {
    prisma.reviewRequest.findFirst.mockResolvedValue(approvedNoReceipt())
    setToolApprovalRegistryForTest({})
    expect(await stateOf()).toBe("NOT_RUN")
  })
  it("an altered stored request (fingerprint no longer matches): Approved, not run", async () => {
    prisma.reviewRequest.findFirst.mockResolvedValue(approvedNoReceipt({}, { fingerprint: "0".repeat(64) }))
    expect(await stateOf()).toBe("NOT_RUN")
  })
  it("a request that expired before the executor ran, or a packet for another workspace: Approved, not run", async () => {
    prisma.reviewRequest.findFirst.mockResolvedValue(approvedNoReceipt({}, { expiresAt: new Date(NOW.getTime() - 1000) }))
    expect(await stateOf()).toBe("NOT_RUN")
    prisma.reviewRequest.findFirst.mockResolvedValue(approvedNoReceipt({ workspaceId: "99999999-9999-4999-8999-999999999999" }))
    expect(await stateOf()).toBe("NOT_RUN")
  })
  it("does not ask who the approver is unless an approved call has no receipt", async () => {
    await loadApprovalView(prisma as never, { requestId: REQ, workspaceId: WS, now: NOW })
    expect(m.isAdmin).not.toHaveBeenCalled()
  })
})

describe("loadApprovalRequester", () => {
  it("reads who raised a tool approval, scoped by id, workspace and gate", async () => {
    prisma.reviewRequest.findFirst.mockResolvedValue({ requestedById: "u1", requestedByAgentId: "a1" })
    expect(await loadApprovalRequester(prisma as never, { requestId: REQ, workspaceId: WS })).toEqual({ userId: "u1", agentId: "a1" })
    expect(prisma.reviewRequest.findFirst.mock.calls[0][0].where).toEqual({ id: REQ, workspaceId: WS, gateType: "TOOL_APPROVAL" })
  })
  it("is null for a malformed id or no row", async () => {
    expect(await loadApprovalRequester(prisma as never, { requestId: "x", workspaceId: WS })).toBeNull()
    prisma.reviewRequest.findFirst.mockResolvedValue(null)
    expect(await loadApprovalRequester(prisma as never, { requestId: REQ, workspaceId: WS })).toBeNull()
  })
})

describe("loadRecentApprovals", () => {
  it("asks for non-pending or expired tool approvals in this workspace, newest first, capped", async () => {
    const found = await loadRecentApprovals(prisma as never, WS, NOW)
    const call = prisma.reviewRequest.findMany.mock.calls[0][0]
    expect(call.where).toMatchObject({ workspaceId: WS, gateType: "TOOL_APPROVAL" })
    expect(JSON.stringify(call.where.OR)).toContain('"not":"PENDING"')
    expect(call.take).toBe(RECENT_APPROVALS_LIMIT)
    expect(RECENT_APPROVALS_LIMIT).toBe(20)
    expect(found).toHaveLength(1)
  })
  it("skips rows whose packet cannot be read and rejects a malformed workspace without querying", async () => {
    prisma.reviewRequest.findMany.mockResolvedValue([row(), row({ id: "44444444-4444-4444-8444-444444444444" }, { packetJson: "nope" })])
    expect(await loadRecentApprovals(prisma as never, WS, NOW)).toHaveLength(1)
    prisma.reviewRequest.findMany.mockClear()
    expect(await loadRecentApprovals(prisma as never, "x", NOW)).toEqual([])
    expect(prisma.reviewRequest.findMany).not.toHaveBeenCalled()
  })
})
