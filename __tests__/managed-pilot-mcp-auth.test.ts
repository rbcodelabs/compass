import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ context: { runId: "run", workspaceId: "workspace", deploymentId: "deployment" }, key: vi.fn(), run: vi.fn(), used: vi.fn().mockResolvedValue({}), initialize: vi.fn() }));
vi.mock("@/lib/preview-automation/managed-context", () => ({ getManagedPilotContext: () => state.context }));
vi.mock("@/lib/db", () => ({ default: () => { state.initialize(); return { apiKey: { findFirst: state.key, update: state.used }, previewAutomationRun: { findUnique: state.run } }; } }));
import { validateMcpAuth } from "@/lib/mcp-auth";
const request = (token = "cmp_" + "a".repeat(32)) => new Request("https://pilot.vercel.app/api/mcp", { headers: { authorization: `Bearer ${token}` } });
beforeEach(() => {
  state.key.mockResolvedValue({ id: "key", userId: "owner", purpose: "USER", scopeWorkspaceId: null });
  state.run.mockResolvedValue({ id: "run", workspaceId: "workspace", deploymentId: "deployment", ownerUserId: "owner", viewerUserId: "viewer", revokedAt: null, expiresAt: new Date(Date.now() + 60000) });
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
it("refuses the global service fallback and OAuth in managed pilots", async () => {
  vi.stubEnv("MCP_API_KEY", "shared");
  expect(await validateMcpAuth(request("shared"))).toEqual({ valid: false });
  expect(await validateMcpAuth(request("cmp_oat_example"))).toEqual({ valid: false });
  expect(state.initialize).not.toHaveBeenCalled();
});
it("narrows synthetic user credentials to the configured workspace", async () => {
  expect(await validateMcpAuth(request())).toEqual(expect.objectContaining({ valid: true, userId: "owner", scopeWorkspaceId: "workspace" }));
});
it.each([
  null,
  { revokedAt: new Date() }, { expiresAt: new Date(0) }, { deploymentId: "wrong" }, { workspaceId: "other" },
])("refuses missing or invalid managed run before recording key use", async override => {
  const original = await state.run();
  state.run.mockResolvedValue(override === null ? null : { ...original, ...override });
  expect(await validateMcpAuth(request())).toEqual({ valid: false });
  expect(state.used).not.toHaveBeenCalled();
});
it.each([{ userId: "outsider" }, { purpose: "AGENT" }, { scopeWorkspaceId: "other" }])("refuses other actors/purposes/workspaces", async override => {
  state.key.mockResolvedValue({ id: "key", userId: "owner", purpose: "USER", scopeWorkspaceId: null, ...override });
  expect(await validateMcpAuth(request())).toEqual({ valid: false });
});
