/**
 * Unit tests for the MCP per-user authorization primitive (lib/mcp-authz.ts).
 *
 * Strategy: mock @/lib/db so the assert helpers query a controllable fake
 * prisma. Every helper has three cases:
 *   - service key (userId: null)      → global bypass, no membership query
 *   - per-user member                 → allowed
 *   - per-user non-member / missing   → McpAuthzError (uniform message)
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const mockPrisma = {
  workspace: { findFirst: vi.fn() },
  workspaceMember: { findFirst: vi.fn() },
  organization: { findUnique: vi.fn() },
  organizationMember: { findFirst: vi.fn() },
  scoringModel: { findUnique: vi.fn() },
  opportunity: { findUnique: vi.fn() },
  solution: { findUnique: vi.fn() },
  task: { findUnique: vi.fn() },
}

vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

import {
  runWithMcpActor,
  getMcpActor,
  McpAuthzError,
  assertWorkspaceMember,
  assertWorkspaceAdmin,
  assertOrgMemberBySlug,
  assertOrgAdminBySlug,
  assertEntityAccess,
  assertScoringModelAccess,
} from "@/lib/mcp-authz"

const SERVICE = { userId: null }
const USER = { userId: "user-1" }
const RESEARCH = { userId: "user-1", purpose: "RESEARCH" as const, scopeWorkspaceId: "ws-1" }

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.organizationMember.findFirst.mockResolvedValue(null)
})

describe("actor context (ALS)", () => {
  it("runWithMcpActor exposes the actor to getMcpActor", () => {
    const seen = runWithMcpActor(USER, () => getMcpActor())
    expect(seen).toEqual({ userId: "user-1" })
  })

  it("getMcpActor throws outside a scope (fail-closed)", () => {
    expect(() => getMcpActor()).toThrow(McpAuthzError)
  })
})

describe("assertWorkspaceMember", () => {
  it("service key bypasses without querying", async () => {
    await expect(assertWorkspaceMember(SERVICE, "ws-1")).resolves.toBeUndefined()
    expect(mockPrisma.workspace.findFirst).not.toHaveBeenCalled()
  })

  it("member is allowed", async () => {
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
    await expect(assertWorkspaceMember(USER, "ws-1")).resolves.toBeUndefined()
    expect(mockPrisma.workspace.findFirst).toHaveBeenCalledWith({
      where: { id: "ws-1", members: { some: { userId: "user-1" } } },
      select: { id: true },
    })
  })

  it("non-member is denied", async () => {
    mockPrisma.workspace.findFirst.mockResolvedValue(null)
    await expect(assertWorkspaceMember(USER, "ws-1")).rejects.toThrow(/not found or access denied/)
  })

  it("research credentials cannot cross their workspace boundary", async () => {
    await expect(assertWorkspaceMember(RESEARCH, "ws-2")).rejects.toThrow(/not found or access denied/)
    expect(mockPrisma.workspace.findFirst).not.toHaveBeenCalled()
  })
})

describe("assertWorkspaceAdmin", () => {
  it("service key bypasses", async () => {
    await expect(assertWorkspaceAdmin(SERVICE, "ws-1")).resolves.toBeUndefined()
    expect(mockPrisma.workspaceMember.findFirst).not.toHaveBeenCalled()
  })

  it("admin allowed, plain member denied, non-member denied", async () => {
    mockPrisma.workspaceMember.findFirst.mockResolvedValueOnce({ role: "ADMIN" })
    await expect(assertWorkspaceAdmin(USER, "ws-1")).resolves.toBeUndefined()

    mockPrisma.workspaceMember.findFirst.mockResolvedValueOnce({ role: "MEMBER" })
    await expect(assertWorkspaceAdmin(USER, "ws-1")).rejects.toThrow(/workspace admin required/)

    mockPrisma.workspaceMember.findFirst.mockResolvedValueOnce(null)
    await expect(assertWorkspaceAdmin(USER, "ws-1")).rejects.toThrow(/not found or access denied/)
  })

  it("normalizes legacy owner roles and inherits organization admin access", async () => {
    mockPrisma.workspaceMember.findFirst.mockResolvedValueOnce({ role: "owner" })
    await expect(assertWorkspaceAdmin(USER, "ws-1")).resolves.toBeUndefined()

    mockPrisma.workspaceMember.findFirst.mockResolvedValueOnce(null)
    mockPrisma.organizationMember.findFirst.mockResolvedValueOnce({ role: "ADMIN" })
    await expect(assertWorkspaceAdmin(USER, "ws-1")).resolves.toBeUndefined()
  })
})

describe("assertOrgMemberBySlug", () => {
  it("service key resolves org id without membership", async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({ id: "org-1" })
    await expect(assertOrgMemberBySlug(SERVICE, "acme")).resolves.toEqual({ organizationId: "org-1" })
    expect(mockPrisma.organizationMember.findFirst).not.toHaveBeenCalled()
  })

  it("member allowed, non-member denied", async () => {
    mockPrisma.organizationMember.findFirst.mockResolvedValueOnce({ organizationId: "org-1" })
    await expect(assertOrgMemberBySlug(USER, "acme")).resolves.toEqual({ organizationId: "org-1" })

    mockPrisma.organizationMember.findFirst.mockResolvedValueOnce(null)
    await expect(assertOrgMemberBySlug(USER, "acme")).rejects.toThrow(/not found or access denied/)
  })
})

describe("assertOrgAdminBySlug", () => {
  it("OWNER/ADMIN allowed, member denied", async () => {
    mockPrisma.organizationMember.findFirst.mockResolvedValueOnce({ organizationId: "org-1", role: "OWNER" })
    await expect(assertOrgAdminBySlug(USER, "acme")).resolves.toEqual({ organizationId: "org-1" })

    mockPrisma.organizationMember.findFirst.mockResolvedValueOnce({ organizationId: "org-1", role: "MEMBER" })
    await expect(assertOrgAdminBySlug(USER, "acme")).rejects.toThrow(/organization admin required/)
  })
})

describe("assertEntityAccess", () => {
  it("resolves a direct-workspace entity (opportunity) and checks membership", async () => {
    mockPrisma.opportunity.findUnique.mockResolvedValue({ workspaceId: "ws-9" })
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-9" })
    await expect(assertEntityAccess(USER, "opportunity", "opp-1")).resolves.toEqual({ workspaceId: "ws-9" })
  })

  it("resolves a nested entity (solution → opportunity → workspace)", async () => {
    mockPrisma.solution.findUnique.mockResolvedValue({ opportunity: { workspaceId: "ws-9" } })
    mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-9" })
    await expect(assertEntityAccess(USER, "solution", "sol-1")).resolves.toEqual({ workspaceId: "ws-9" })
  })

  it("missing entity is denied with the uniform message", async () => {
    mockPrisma.opportunity.findUnique.mockResolvedValue(null)
    await expect(assertEntityAccess(USER, "opportunity", "opp-x")).rejects.toThrow(/not found or access denied/)
    expect(mockPrisma.workspace.findFirst).not.toHaveBeenCalled()
  })

  it("entity exists but caller is not a member → denied (no existence leak)", async () => {
    mockPrisma.opportunity.findUnique.mockResolvedValue({ workspaceId: "ws-9" })
    mockPrisma.workspace.findFirst.mockResolvedValue(null)
    await expect(assertEntityAccess(USER, "opportunity", "opp-1")).rejects.toThrow(/not found or access denied/)
  })

  it("research credentials cannot read an entity from another workspace", async () => {
    mockPrisma.opportunity.findUnique.mockResolvedValue({ workspaceId: "ws-2" })
    await expect(assertEntityAccess(RESEARCH, "opportunity", "opp-1")).rejects.toThrow(/not found or access denied/)
    expect(mockPrisma.workspace.findFirst).not.toHaveBeenCalled()
  })

  it("service key skips the membership query", async () => {
    mockPrisma.task.findUnique.mockResolvedValue({ workspaceId: "ws-9" })
    await expect(assertEntityAccess(SERVICE, "task", "task-1")).resolves.toEqual({ workspaceId: "ws-9" })
    expect(mockPrisma.workspace.findFirst).not.toHaveBeenCalled()
  })
})

describe("assertScoringModelAccess", () => {
  it("member read allowed; admin required for admin ops", async () => {
    mockPrisma.scoringModel.findUnique.mockResolvedValue({ organizationId: "org-1" })
    mockPrisma.organizationMember.findFirst.mockResolvedValueOnce({ role: "MEMBER" })
    await expect(assertScoringModelAccess(USER, "sm-1")).resolves.toEqual({ organizationId: "org-1" })

    mockPrisma.scoringModel.findUnique.mockResolvedValue({ organizationId: "org-1" })
    mockPrisma.organizationMember.findFirst.mockResolvedValueOnce({ role: "MEMBER" })
    await expect(assertScoringModelAccess(USER, "sm-1", { admin: true })).rejects.toThrow(/organization admin required/)
  })

  it("missing model denied; service key bypasses membership", async () => {
    mockPrisma.scoringModel.findUnique.mockResolvedValueOnce(null)
    await expect(assertScoringModelAccess(USER, "sm-x")).rejects.toThrow(/not found or access denied/)

    mockPrisma.scoringModel.findUnique.mockResolvedValueOnce({ organizationId: "org-1" })
    await expect(assertScoringModelAccess(SERVICE, "sm-1", { admin: true })).resolves.toEqual({ organizationId: "org-1" })
    expect(mockPrisma.organizationMember.findFirst).not.toHaveBeenCalled()
  })
})
