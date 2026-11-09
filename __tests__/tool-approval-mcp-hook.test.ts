/**
 * The register() hook in app/api/mcp/route.ts and the registry contract.
 *
 * - With the production (empty) registry NO tool in the catalog is intercepted: every tool behaves exactly as before.
 * - With a tool injected into the test registry, the wrapper never reaches the handler; it returns APPROVAL_REQUIRED, and any
 *   failure refuses instead of falling through.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runWithMcpActor } from "@/lib/mcp-authz"

const mockPrisma = {
  workspace: { findMany: vi.fn(), findFirst: vi.fn() },
  organization: { findUnique: vi.fn(), findMany: vi.fn() },
  workspaceMember: { findFirst: vi.fn() },
  agent: { findFirst: vi.fn() },
  agentToolCall: { create: vi.fn(), update: vi.fn() },
  agentWorkspaceGrant: { findMany: vi.fn() },
}
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

const requestMock = vi.hoisted(() => ({ requestToolApproval: vi.fn() }))
vi.mock("@/lib/tool-approval/request", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tool-approval/request")>()), requestToolApproval: requestMock.requestToolApproval }))

type ToolCallback = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; structuredContent: { ok: boolean; data: Record<string, unknown> } }>
const registeredTools: Record<string, ToolCallback> = {}
vi.mock("mcp-handler", () => ({
  createMcpHandler: (setup: (server: { registerTool: (n: string, m: unknown, cb: ToolCallback) => void; registerResource: (...a: unknown[]) => void }) => void) => {
    setup({ registerTool(name, _m, cb) { registeredTools[name] = cb }, registerResource() {} })
    return () => new Response("ok")
  },
}))
vi.mock("@/lib/mcp-auth", () => ({ validateMcpAuth: vi.fn().mockResolvedValue({ valid: true }) }))
process.env.COMPASS_SLACK_CONNECTOR = "slack/test"
await import("@/app/api/mcp/route")

import { getToolApprovalSpec, registeredToolApprovalNames, setToolApprovalRegistryForTest, type ToolApprovalSpec } from "@/lib/tool-approval/registry"
import { interceptToolForApproval } from "@/lib/tool-approval/mcp-hook"
import { restOperationIsApprovalGated } from "@/lib/tool-approval/rest-guard"

const TOOL = "get_current_identity"
const WS = "11111111-1111-4111-8111-111111111111"
const spec: ToolApprovalSpec = {
  toolName: TOOL, capabilityClass: "test.identity",
  describe: () => ({ title: "t", summary: "s" }), readBefore: () => null, computeAfter: () => null, execute: vi.fn(),
}
const required = {
  status: "APPROVAL_REQUIRED", requestId: "req-1", revisionId: "rev-1", displayId: "DEC-7", path: "/acme/product/approvals/req-1",
  title: "Set repos", summary: "Adds a repo", before: ["a/b"], after: ["a/b", "a/c"], expiresAt: new Date("2030-01-01T00:00:00Z"), reused: false,
}
const as = (actor: Record<string, unknown>, name = TOOL, args: Record<string, unknown> = {}) => runWithMcpActor(actor as never, () => registeredTools[name](args))

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.workspace.findMany.mockResolvedValue([])
  mockPrisma.agent.findFirst.mockResolvedValue({ id: "agent-1", ownerUserId: "owner-1", status: "ACTIVE" })
  mockPrisma.agentWorkspaceGrant.findMany.mockResolvedValue([])
  mockPrisma.agentToolCall.create.mockResolvedValue({ id: "call-1" })
})
afterEach(() => setToolApprovalRegistryForTest(null))

describe("the production registry is empty", () => {
  it("lists no tool and returns no spec for any tool in the MCP catalog", () => {
    expect(registeredToolApprovalNames()).toEqual([])
    const names = Object.keys(registeredTools)
    expect(names.length).toBeGreaterThan(150)
    for (const name of names) expect(getToolApprovalSpec(name)).toBeUndefined()
  })

  it("the hook is a no-op for every catalog tool: returns null and never reaches the database", async () => {
    for (const name of Object.keys(registeredTools)) {
      expect(await interceptToolForApproval({ toolName: name, actor: { userId: null, purpose: "SERVICE" }, resolveArgs: async () => ({ workspaceId: WS }) })).toBeNull()
    }
    expect(requestMock.requestToolApproval).not.toHaveBeenCalled()
    expect(Object.values(mockPrisma).flatMap((model) => Object.values(model)).every((fn) => fn.mock.calls.length === 0)).toBe(true)
  })

  it("an unlisted tool still runs its handler through the wrapper, unchanged", async () => {
    const result = await as({ userId: null, purpose: "SERVICE" })
    expect(result.structuredContent.ok).toBe(true)
    expect(mockPrisma.workspace.findMany).toHaveBeenCalledTimes(1)
    expect(requestMock.requestToolApproval).not.toHaveBeenCalled()
  })

  it("registering a tool under the wrong name or without a capability class is rejected, and production code cannot inject", () => {
    expect(() => setToolApprovalRegistryForTest({ other: spec })).toThrow(/does not match/)
    expect(() => setToolApprovalRegistryForTest({ [TOOL]: { ...spec, capabilityClass: " " } })).toThrow(/capabilityClass/)
    vi.stubEnv("NODE_ENV", "production")
    try {
      expect(() => setToolApprovalRegistryForTest({ [TOOL]: spec })).toThrow(/only available/)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("an injected registry is ignored outside the test runtime", () => {
    setToolApprovalRegistryForTest({ [TOOL]: spec })
    expect(getToolApprovalSpec(TOOL)).toBe(spec)
    vi.stubEnv("NODE_ENV", "production")
    try {
      expect(getToolApprovalSpec(TOOL)).toBeUndefined()
      expect(registeredToolApprovalNames()).toEqual([])
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe("an opted-in tool never reaches its handler", () => {
  beforeEach(() => {
    setToolApprovalRegistryForTest({ [TOOL]: spec })
    requestMock.requestToolApproval.mockResolvedValue(required)
  })

  it.each([
    ["service actor", { userId: null, purpose: "SERVICE" }],
    ["user actor", { userId: "user-1", purpose: "USER" }],
    ["agent-key actor", { userId: "owner-1", purpose: "AGENT", agentId: "agent-1", credentialId: "cred-1" }],
  ])("%s gets APPROVAL_REQUIRED and the handler's prisma reads never happen", async (_label, actor) => {
    const result = await as(actor)
    expect(result.structuredContent.ok).toBe(true)
    expect(result.structuredContent.data).toMatchObject({ status: "APPROVAL_REQUIRED", executed: false, requestId: "req-1", displayId: "DEC-7", path: "/acme/product/approvals/req-1", before: ["a/b"], after: ["a/b", "a/c"] })
    const text = result.content[0].text
    expect(text).toContain("NOT performed")
    expect(text).toContain("ID: req-1")
    expect(text).toContain("Display ID: DEC-7")
    expect(text).toContain("/acme/product/approvals/req-1")
    expect(text).toContain('Current: ["a/b"]')
    expect(text).toContain('Proposed: ["a/b","a/c"]')
    expect(mockPrisma.workspace.findMany).not.toHaveBeenCalled()
    expect(spec.execute).not.toHaveBeenCalled()
  })

  it("passes the requester identity and the already-resolved args, and ignores any decision id the caller supplies", async () => {
    await as({ userId: "owner-1", purpose: "AGENT", agentId: "agent-1", credentialId: "cred-1" }, TOOL, { decisionId: "d1", approved: true })
    expect(requestMock.requestToolApproval).toHaveBeenCalledWith({ toolName: TOOL, args: expect.any(Object), requester: { userId: "owner-1", agentId: "agent-1" } })
    expect(spec.execute).not.toHaveBeenCalled()
    expect(mockPrisma.workspace.findMany).not.toHaveBeenCalled()
  })

  it("fails closed when filing the request throws: refusal, no handler", async () => {
    requestMock.requestToolApproval.mockRejectedValue(new Error("database is down"))
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const result = await as({ userId: null, purpose: "SERVICE" })
    expect(result.structuredContent).toMatchObject({ ok: false, data: { status: "APPROVAL_UNAVAILABLE", executed: false } })
    expect(result.content[0].text).not.toContain("database is down")
    expect(mockPrisma.workspace.findMany).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it("reports a full queue, a hard-blocked call and a vanished registration as refusals", async () => {
    const { ToolApprovalError } = await import("@/lib/tool-approval/errors")
    requestMock.requestToolApproval.mockRejectedValueOnce(new ToolApprovalError("TOO_MANY_PENDING", "This workspace already has 25 approvals waiting."))
    expect((await as({ userId: null, purpose: "SERVICE" })).structuredContent).toMatchObject({ ok: false, data: { status: "TOO_MANY_PENDING", executed: false } })
    requestMock.requestToolApproval.mockResolvedValueOnce({ status: "BLOCKED", floors: ["no"] })
    expect((await as({ userId: null, purpose: "SERVICE" })).structuredContent).toMatchObject({ ok: false, data: { status: "BLOCKED", executed: false, floors: ["no"] } })
    requestMock.requestToolApproval.mockResolvedValueOnce({ status: "NOT_REGISTERED" })
    expect((await as({ userId: null, purpose: "SERVICE" })).structuredContent).toMatchObject({ ok: false, data: { status: "APPROVAL_UNAVAILABLE", executed: false } })
    expect(mockPrisma.workspace.findMany).not.toHaveBeenCalled()
  })

  it("other tools are unaffected while one is registered", async () => {
    mockPrisma.organization.findUnique.mockResolvedValue(null)
    await as({ userId: null, purpose: "SERVICE" }, "list_workspaces", { orgSlug: "acme" }).catch(() => undefined)
    // Reached its own handler (which reads the organization), untouched by the approval hook.
    expect(mockPrisma.organization.findUnique).toHaveBeenCalled()
    expect(requestMock.requestToolApproval).not.toHaveBeenCalled()
  })

  it("REST cannot be used to bypass the hook for an opted-in tool", () => {
    expect(restOperationIsApprovalGated("getCurrentIdentity")).toBe(true)
    expect(restOperationIsApprovalGated("listTasks")).toBe(false)
    setToolApprovalRegistryForTest({})
    expect(restOperationIsApprovalGated("getCurrentIdentity")).toBe(false)
  })
})
