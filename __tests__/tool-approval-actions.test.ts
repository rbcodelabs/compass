import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  revalidatePath: vi.fn(),
  run: vi.fn(),
  isAdmin: vi.fn(),
  loadView: vi.fn(),
  prisma: {} as Record<string, Record<string, ReturnType<typeof vi.fn>>>,
}))
vi.mock("@/auth", () => ({ auth: m.auth }))
vi.mock("next/cache", () => ({ revalidatePath: m.revalidatePath }))
vi.mock("@/lib/db", () => ({ default: () => m.prisma }))
vi.mock("@/lib/agent-ownership", () => ({ isWorkspaceAdminUser: m.isAdmin }))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/approvals/decision-core", () => ({ runApprovalDecision: m.run }))
vi.mock("@/lib/tool-approval/view", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tool-approval/view")>()), loadApprovalView: m.loadView }))

import { decideApprovalAction, decideApprovalFromChatAction, getApprovalCardAction } from "@/app/[orgSlug]/[workspaceSlug]/approvals/actions"

const USER = "11111111-1111-4111-8111-111111111111"
const WS = "22222222-2222-4222-8222-222222222222"
const REQ = "33333333-3333-4333-8333-333333333333"
const CONV = "44444444-4444-4444-8444-444444444444"
const SUBMISSION = `ta-${"0123456789abcdef".repeat(2)}`
const scope = { orgSlug: "acme", workspaceSlug: "product", requestId: REQ }

beforeEach(() => {
  vi.clearAllMocks()
  m.auth.mockResolvedValue({ user: { id: USER } })
  m.run.mockResolvedValue({ ok: true, tone: "success", message: "done" })
  m.prisma = { workspace: { findFirst: vi.fn().mockResolvedValue({ id: WS }) } }
})

describe("decideApprovalAction (the approval page)", () => {
  it("decides as the signed-in user in the workspace named by the URL slugs, then revalidates the page and list", async () => {
    const r = await decideApprovalAction(scope, "APPROVE", SUBMISSION)
    expect(r.ok).toBe(true)
    expect(m.prisma.workspace.findFirst).toHaveBeenCalledWith({ where: { slug: "product", organization: { slug: "acme" } }, select: { id: true } })
    expect(m.run).toHaveBeenCalledWith({ userId: USER, workspaceId: WS, requestId: REQ, action: "APPROVE", idempotencyKey: SUBMISSION })
    expect(m.revalidatePath).toHaveBeenCalledWith(`/acme/product/approvals/${REQ}`)
    expect(m.revalidatePath).toHaveBeenCalledWith("/acme/product/approvals")
  })

  it("the acting user is only ever the session user: a forged userId in the scope is not forwarded", async () => {
    await decideApprovalAction({ ...scope, userId: "99999999-9999-4999-8999-999999999999" } as never, "REJECT", SUBMISSION)
    expect(m.run.mock.calls[0][0].userId).toBe(USER)
  })

  it("refuses when signed out, and when the slugs name no workspace", async () => {
    m.auth.mockResolvedValue(null)
    expect((await decideApprovalAction(scope, "APPROVE", SUBMISSION)).ok).toBe(false)
    m.auth.mockResolvedValue({ user: { id: USER } })
    m.prisma.workspace.findFirst.mockResolvedValue(null)
    expect((await decideApprovalAction(scope, "APPROVE", SUBMISSION)).ok).toBe(false)
    expect(m.run).not.toHaveBeenCalled()
  })
})

describe("decideApprovalFromChatAction (the chat card)", () => {
  it("passes the open workspace and conversation with the session user", async () => {
    await decideApprovalFromChatAction({ workspaceId: WS, requestId: REQ, conversationId: CONV }, "APPROVE", SUBMISSION)
    expect(m.run).toHaveBeenCalledWith({ userId: USER, workspaceId: WS, requestId: REQ, action: "APPROVE", idempotencyKey: SUBMISSION, conversationId: CONV })
  })
  it("refuses when signed out", async () => {
    m.auth.mockResolvedValue(null)
    expect((await decideApprovalFromChatAction({ workspaceId: WS, requestId: REQ, conversationId: null }, "APPROVE", SUBMISSION)).ok).toBe(false)
    expect(m.run).not.toHaveBeenCalled()
  })
})

describe("getApprovalCardAction", () => {
  const fullView = { requestId: REQ, displayId: "DEC-3", path: "/acme/product/approvals/" + REQ, tool: "set_workspace_description", capabilityClass: "workspace.description", title: "Set description to SECRET-TITLE", summary: "SECRET-SUMMARY", args: { d: "SECRET-ARG" }, before: "SECRET-BEFORE", after: "SECRET-AFTER", state: { key: "PENDING", terminal: false }, requestedBy: "agent", createdAt: "2026-11-09T00:00:00.000Z", expiresAt: null, decision: null, receipt: null }
  beforeEach(() => {
    m.prisma.workspace.findFirst.mockResolvedValue({ members: [{ id: "m" }], organization: { members: [] } })
    m.loadView.mockResolvedValue(fullView)
    m.isAdmin.mockResolvedValue(true)
  })

  it("gives a workspace admin the full stored view and canDecide", async () => {
    const r = await getApprovalCardAction({ workspaceId: WS, requestId: REQ })
    expect(r).toMatchObject({ canDecide: true, effectWithheld: false, view: { title: "Set description to SECRET-TITLE", before: "SECRET-BEFORE" } })
  })

  it("gives a plain member the status only: no title, summary, tool, arguments, before or after", async () => {
    m.isAdmin.mockResolvedValue(false)
    const r = await getApprovalCardAction({ workspaceId: WS, requestId: REQ })
    expect(r).toMatchObject({ canDecide: false, effectWithheld: true })
    expect(JSON.stringify(r)).not.toMatch(/SECRET|set_workspace_description|workspace\.description/)
    expect(r!.view.state.key).toBe("PENDING")
  })

  it("gives nothing to a non-member, a signed-out caller, a bad id, or another workspace's request", async () => {
    m.prisma.workspace.findFirst.mockResolvedValue({ members: [], organization: { members: [] } })
    expect(await getApprovalCardAction({ workspaceId: WS, requestId: REQ })).toBeNull()
    m.prisma.workspace.findFirst.mockResolvedValue({ members: [{ id: "m" }], organization: { members: [] } })
    m.loadView.mockResolvedValue(null)
    expect(await getApprovalCardAction({ workspaceId: WS, requestId: REQ })).toBeNull()
    expect(await getApprovalCardAction({ workspaceId: "nope", requestId: REQ })).toBeNull()
    m.auth.mockResolvedValue(null)
    expect(await getApprovalCardAction({ workspaceId: WS, requestId: REQ })).toBeNull()
  })

  it("an organization admin who is not a workspace member can read the card", async () => {
    m.prisma.workspace.findFirst.mockResolvedValue({ members: [], organization: { members: [{ role: "ADMIN" }] } })
    expect(await getApprovalCardAction({ workspaceId: WS, requestId: REQ })).not.toBeNull()
  })
})
