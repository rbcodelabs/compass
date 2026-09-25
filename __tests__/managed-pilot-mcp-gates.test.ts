import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ db: {
  workspace: { findFirst: vi.fn() }, workspaceMember: { findFirst: vi.fn() },
  organizationMember: { findFirst: vi.fn() }, scoringModel: { findUnique: vi.fn() },
} }));
vi.mock("@/lib/db", () => ({ default: () => state.db }));
vi.mock("@/lib/preview-automation/managed-context", () => ({ getManagedPilotContext: () => ({ workspaceId: "primary" }) }));
import { applyToolGate } from "@/lib/mcp-tool-gates";
const actor = { userId: "synthetic-owner", purpose: "USER" as const, scopeWorkspaceId: "primary" };
beforeEach(() => {
  vi.clearAllMocks();
  state.db.workspace.findFirst.mockResolvedValue({ id: "primary" });
  state.db.workspaceMember.findFirst.mockResolvedValue({ role: "ADMIN" });
  state.db.organizationMember.findFirst.mockResolvedValue({ organizationId: "org", role: "OWNER" });
  state.db.scoringModel.findUnique.mockResolvedValue({ organizationId: "org" });
});
it("denies the real workspace admin gate despite organization OWNER", async () => {
  await expect(applyToolGate("set_workspace_scoring_model", actor, { workspaceId: "isolated", scoringModelId: null })).rejects.toThrow();
  expect(state.db.organizationMember.findFirst).not.toHaveBeenCalled();
});
it.each([
  ["create_workspace", { orgSlug: "synthetic" }],
  ["create_scoring_model", { orgSlug: "synthetic" }],
  ["update_scoring_model", { scoringModelId: "model" }],
  ["archive_scoring_model", { scoringModelId: "model" }],
])("denies organization-wide managed mutation %s", async (tool, args) => {
  await expect(applyToolGate(tool as string, actor, args as Record<string, unknown>)).rejects.toThrow();
});
it("still permits document creation in the primary workspace", async () => {
  await expect(applyToolGate("create_doc", actor, { workspaceId: "primary" })).resolves.toBeUndefined();
});
