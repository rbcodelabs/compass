import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), admin: vi.fn(), enabled: vi.fn(),
  agent: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  apiKey: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  workspaceMember: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  $transaction: vi.fn(),
  agentWorkspaceGrant: { upsert: vi.fn(), updateMany: vi.fn() },
}));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({ default: () => mocks }));
vi.mock("@/lib/permissions", () => ({ resolveWorkspaceAdmin: mocks.admin }));
vi.mock("@/lib/agent-access", () => ({ agentsEnabled: mocks.enabled }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { createAgent, updateAgent, createAgentKey, revokeAgentKey, grantWorkspaceAgent, revokeWorkspaceAgent } from "@/app/settings/agents/actions";
import { validateMcpAuth } from "@/lib/mcp-auth";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "owner" } });
  mocks.enabled.mockReturnValue(true);
  mocks.agent.findFirst.mockResolvedValue({ id: "agent", ownerUserId: "owner", status: "ACTIVE" });
  mocks.admin.mockResolvedValue({ prisma: mocks, workspaceId: "workspace" });
  mocks.workspaceMember.findFirst.mockResolvedValue({ id: "member", role: "MEMBER" });
  mocks.workspaceMember.updateMany.mockResolvedValue({ count: 1 });
  mocks.$transaction.mockImplementation((operation) => operation(mocks));
  mocks.apiKey.create.mockResolvedValue({ id: "persisted-key" });
});

describe("agent account and workspace management", () => {
  it("authenticates a key minted by the account UI with the MCP validator", async () => {
    vi.stubEnv("COMPASS_AGENTS_ENABLED", "1");
    try {
      mocks.apiKey.create.mockImplementation(async ({ data }) => {
        mocks.apiKey.findFirst.mockImplementation(async ({ where }) => where.keyPrefix === data.keyPrefix && where.keyHash === data.keyHash ? { id: "persisted-key", ...data, scopeWorkspaceId: null } : null);
        return { id: "persisted-key" };
      });
      mocks.apiKey.update.mockResolvedValue({});
      const { rawKey } = await createAgentKey("agent", { name: "Integration" });
      await expect(validateMcpAuth(new Request("https://compass.test/api/mcp", { headers: { authorization: `Bearer ${rawKey}` } }))).resolves.toMatchObject({ valid: true, purpose: "AGENT", agentId: "agent", userId: "owner", credentialId: "persisted-key" });
    } finally { vi.unstubAllEnvs(); }
  });
  it("creates an account identity without workspace membership", async () => {
    await createAgent({ name: " Engineer " });
    expect(mocks.agent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ ownerUserId: "owner", name: "Engineer" }) });
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("requires authentication", async () => {
    mocks.auth.mockResolvedValue(null);
    await expect(createAgent({ name: "Engineer" })).rejects.toThrow("Unauthorized");
  });
  it("rejects another user's agent", async () => {
    mocks.agent.findFirst.mockResolvedValue(null);
    await expect(updateAgent("other", { name: "Changed", status: "ACTIVE" })).rejects.toThrow("Agent not found");
    expect(mocks.agent.update).not.toHaveBeenCalled();
  });
  it("returns the persisted key ID and only stores its hash", async () => {
    const key = await createAgentKey("agent", { name: "Laptop" });
    expect(key.id).toBe("persisted-key");
    expect(key.rawKey).toMatch(/^cmp_/);
    expect(mocks.apiKey.create).toHaveBeenCalledWith({ data: expect.objectContaining({ agentId: "agent", userId: "owner", purpose: "AGENT", expiresAt: null, keyHash: expect.not.stringContaining(key.rawKey) }), select: { id: true } });
  });
  it("rejects expired and invalid expiry dates", async () => {
    await expect(createAgentKey("agent", { name: "Laptop", expiresAt: "invalid" })).rejects.toThrow("Expiry");
    await expect(createAgentKey("agent", { name: "Laptop", expiresAt: "2000-01-01" })).rejects.toThrow("Expiry");
  });
  it("does not mint keys for suspended agents", async () => {
    mocks.agent.findFirst.mockResolvedValue({ id: "agent", status: "SUSPENDED" });
    await expect(createAgentKey("agent", { name: "Laptop" })).rejects.toThrow("suspended");
  });
  it("prevents grant expansion when rollout is disabled", async () => {
    mocks.enabled.mockReturnValue(false);
    await expect(grantWorkspaceAgent("org", "ws", "agent", "WRITE")).rejects.toThrow("disabled");
  });
  it("requires admin authority and owner membership for grants", async () => {
    mocks.workspaceMember.findFirst.mockResolvedValue(null);
    await expect(grantWorkspaceAgent("org", "ws", "agent", "WRITE")).rejects.toThrow("current workspace member");
    expect(mocks.agentWorkspaceGrant.upsert).not.toHaveBeenCalled();
  });
  it("requires admin role even when agent owner", async () => {
    mocks.admin.mockRejectedValue(new Error("Forbidden"));
    await expect(grantWorkspaceAgent("org", "ws", "agent", "WRITE")).rejects.toThrow("Forbidden");
  });
  it("explicitly restores a revoked grant without changing a credential", async () => {
    await grantWorkspaceAgent("org", "ws", "agent", "READ");
    expect(mocks.agentWorkspaceGrant.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { agentId_workspaceId: { agentId: "agent", workspaceId: "workspace" } }, update: expect.objectContaining({ revokedAt: null, access: "READ" }) }));
    expect(mocks.apiKey.create).not.toHaveBeenCalled();
    expect(mocks.workspaceMember.updateMany).toHaveBeenCalledWith({ where: { id: "member", role: "MEMBER" }, data: { role: "MEMBER" } });
    expect(mocks.$transaction).toHaveBeenCalled();
  });
  it("allows revocation while rollout is disabled", async () => {
    mocks.enabled.mockReturnValue(false);
    mocks.apiKey.findFirst.mockResolvedValue({ id: "key" });
    await revokeAgentKey("key");
    await revokeWorkspaceAgent("org", "ws", "agent");
    expect(mocks.apiKey.update).toHaveBeenCalled();
    expect(mocks.agentWorkspaceGrant.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { agentId: "agent", workspaceId: "workspace", revokedAt: null } }));
  });
  it("does not overwrite a concurrent membership role change when granting access", async () => {
    mocks.workspaceMember.updateMany.mockResolvedValue({ count: 0 });
    await expect(grantWorkspaceAgent("org", "ws", "agent", "READ")).rejects.toThrow("Membership changed");
    expect(mocks.agentWorkspaceGrant.upsert).not.toHaveBeenCalled();
  });
});
