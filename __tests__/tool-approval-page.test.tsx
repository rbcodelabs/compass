import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"

const m = vi.hoisted(() => ({ auth: vi.fn(), isAdmin: vi.fn(), loadView: vi.fn(), loadRecent: vi.fn(), listPending: vi.fn(), findWorkspace: vi.fn() }))
vi.mock("@/auth", () => ({ auth: m.auth }))
vi.mock("@/lib/db", () => ({ default: () => ({ workspace: { findFirst: m.findWorkspace } }) }))
vi.mock("@/lib/agent-ownership", () => ({ isWorkspaceAdminUser: m.isAdmin }))
vi.mock("@/lib/tool-approval/view", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tool-approval/view")>()), loadApprovalView: m.loadView, loadRecentApprovals: m.loadRecent }))
vi.mock("@/lib/tool-approval/request", () => ({ listPendingToolApprovals: m.listPending }))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/approvals/actions", () => ({ decideApprovalAction: Object.assign(vi.fn(), { bind: () => vi.fn() }) }))
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND") }),
  redirect: vi.fn(() => { throw new Error("NEXT_REDIRECT") }),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/acme/product/approvals",
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock("@/components/patterns/workspace-page", () => ({ WorkspacePage: ({ title, children }: { title: string; children: ReactNode }) => <div><h1>{title}</h1>{children}</div> }))

import ToolApprovalPage from "@/app/[orgSlug]/[workspaceSlug]/approvals/[requestId]/page"
import ToolApprovalsPage from "@/app/[orgSlug]/[workspaceSlug]/approvals/page"
import { APPROVAL_STATES, type ApprovalStateKey } from "@/lib/tool-approval/state"
import type { ApprovalView } from "@/lib/tool-approval/view"

const WS = "22222222-2222-4222-8222-222222222222"
const REQ = "33333333-3333-4333-8333-333333333333"
const params = Promise.resolve({ orgSlug: "acme", workspaceSlug: "product", requestId: REQ })

const view = (key: ApprovalStateKey, over: Partial<ApprovalView> = {}): ApprovalView => ({
  requestId: REQ, displayId: "DEC-9", path: `/acme/product/approvals/${REQ}`, tool: "set_workspace_description", capabilityClass: "workspace.description",
  title: "Set description to <b>x</b>", summary: "Changes the workspace description.", args: { workspaceId: WS, description: "new" }, before: { description: "old" }, after: { description: "new" },
  state: { key, ...APPROVAL_STATES[key] }, requestedBy: "agent", createdAt: "2026-11-09T10:00:00.000Z", expiresAt: "2026-11-10T10:00:00.000Z", decision: null, receipt: null, ...over,
})
const render = async () => renderToStaticMarkup(await ToolApprovalPage({ params }))

beforeEach(() => {
  vi.clearAllMocks()
  m.auth.mockResolvedValue({ user: { id: "u1" } })
  m.findWorkspace.mockResolvedValue({ id: WS })
  m.isAdmin.mockResolvedValue(true)
  m.loadView.mockResolvedValue(view("PENDING"))
})

describe("approval page: access", () => {
  it("shows an admin the escaped title, the before -> after diff and enabled Approve / Deny buttons", async () => {
    const html = await render()
    expect(html).toContain("Tool approval · DEC-9")
    expect(html).toContain("Set description to &lt;b&gt;x&lt;/b&gt;")
    expect(html).not.toContain("<b>x</b>")
    expect(html).toContain("What will change")
    expect(html).toContain("&quot;old&quot;")
    expect(html).toContain("&quot;new&quot;")
    expect(html).toContain('data-testid="approve-button"')
    expect(html).toContain('data-testid="deny-button"')
    expect(html).not.toMatch(/data-testid="approve-button"[^>]*disabled/)
    expect(html).toContain("min-w-0")
  })

  it("gives a member (not a workspace or organization admin) a 404 and never loads the request", async () => {
    m.isAdmin.mockResolvedValue(false)
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND")
    expect(m.loadView).not.toHaveBeenCalled()
  })

  it("404s for an unknown workspace, an unknown or foreign request, and redirects the signed-out", async () => {
    m.findWorkspace.mockResolvedValue(null)
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND")
    m.findWorkspace.mockResolvedValue({ id: WS })
    m.loadView.mockResolvedValue(null)
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND")
    expect(m.loadView).toHaveBeenCalledWith(expect.anything(), { requestId: REQ, workspaceId: WS })
    m.auth.mockResolvedValue(null)
    await expect(render()).rejects.toThrow("NEXT_REDIRECT")
  })
})

describe("approval page: every state", () => {
  const terminal: ApprovalStateKey[] = ["APPLIED", "DENIED", "EXPIRED", "STALE", "FAILED", "UNKNOWN_OUTCOME", "BLOCKED", "NOT_RUN", "SUPERSEDED"]
  it.each(terminal)("%s shows its label and explanation and no Approve / Deny buttons", async (key) => {
    m.loadView.mockResolvedValue(view(key, { decision: key === "EXPIRED" || key === "SUPERSEDED" ? null : { approved: key !== "DENIED", decidedAt: "2026-11-09T11:00:00.000Z", decidedByName: "Ada Admin" } }))
    const html = await render()
    expect(html).toContain(`data-state="${key}"`)
    expect(html).toContain(APPROVAL_STATES[key].label)
    expect(html).toContain('data-testid="approval-outcome"')
    expect(html).not.toContain('data-testid="approve-button"')
    expect(html).not.toContain('data-testid="deny-button"')
  })

  it("names who decided and when, and shows the receipt result and sanitised error", async () => {
    m.loadView.mockResolvedValue(view("FAILED", {
      decision: { approved: true, decidedAt: "2026-11-09T11:00:00.000Z", decidedByName: "Ada Admin" },
      receipt: { status: "FAILED", appliedAt: null, error: "Error: boom" },
    }))
    const html = await render()
    expect(html).toContain("Approved by Ada Admin at 2026-11-09 11:00 UTC")
    expect(html).toContain("Receipt: failed. Error: boom")
  })

  it("unknown outcome tells the reader an operator must check", async () => {
    m.loadView.mockResolvedValue(view("UNKNOWN_OUTCOME", { receipt: { status: "PENDING", appliedAt: null, error: null } }))
    expect(await render()).toMatch(/operator must check the target/)
  })

  it("applying has no buttons and is the only terminal-looking state that refreshes itself", async () => {
    m.loadView.mockResolvedValue(view("APPLYING"))
    const html = await render()
    expect(html).not.toContain('data-testid="approve-button"')
    expect(html).toContain("Applying")
  })

  it("shows the full effect for a terminal state too, so the record stays readable", async () => {
    m.loadView.mockResolvedValue(view("APPLIED"))
    expect(await render()).toContain("What will change")
  })
})

describe("approvals list page", () => {
  const listParams = Promise.resolve({ orgSlug: "acme", workspaceSlug: "product" })
  const pendingRow = { requestId: REQ, displayId: "DEC-9", path: "", tool: "set_workspace_description", capabilityClass: "c", title: "Set it", summary: "S", before: null, after: null, requestedByUserId: null, requestedByAgentId: null, createdAt: new Date("2026-11-09T10:00:00Z"), expiresAt: new Date("2026-11-10T10:00:00Z") }

  it("404s for a non-admin before listing anything", async () => {
    m.isAdmin.mockResolvedValue(false)
    await expect(ToolApprovalsPage({ params: listParams })).rejects.toThrow("NEXT_NOT_FOUND")
    expect(m.listPending).not.toHaveBeenCalled()
  })

  it("lists waiting requests with links to their pages and recently decided ones with their state", async () => {
    m.listPending.mockResolvedValue([pendingRow])
    m.loadRecent.mockResolvedValue([view("DENIED", { requestId: "55555555-5555-4555-8555-555555555555", displayId: "DEC-8", title: "Older one", decision: { approved: false, decidedAt: "2026-11-08T10:00:00.000Z", decidedByName: "Ada" } })])
    const html = renderToStaticMarkup(await ToolApprovalsPage({ params: listParams }))
    expect(m.listPending).toHaveBeenCalledWith(WS, { userId: "u1" })
    expect(html).toContain(`href="/acme/product/approvals/${REQ}"`)
    expect(html).toContain("Waiting for approval")
    expect(html).toContain("Pending")
    expect(html).toContain("Recently decided")
    expect(html).toContain("Older one")
    expect(html).toContain("Denied 2026-11-08 10:00 UTC by Ada")
  })

  it("shows empty states", async () => {
    m.listPending.mockResolvedValue([])
    m.loadRecent.mockResolvedValue([])
    const html = renderToStaticMarkup(await ToolApprovalsPage({ params: listParams }))
    expect(html).toContain("Nothing is waiting")
    expect(html).toContain("No approvals have been decided yet")
  })
})
