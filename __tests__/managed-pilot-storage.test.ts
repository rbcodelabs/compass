import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ run: vi.fn(), context: { schema: "compass_pr_276_aaaaaaaaaaaa", runId: "run", workspaceId: "workspace", deploymentId: "deployment" } }));
vi.mock("@/lib/preview-automation/managed-context", () => ({ getManagedPilotContext: () => state.context }));
vi.mock("@/lib/schema", () => ({ getActiveSchema: () => state.context.schema }));
vi.mock("@/lib/db", () => ({ default: () => ({ previewAutomationRun: { findUnique: state.run } }) }));
import { getDocumentStore, isDocumentPilotWorkspace } from "@/lib/document-storage";
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it("refuses a pilot workspace outside its configured synthetic run", () => {
  vi.stubEnv("GEODE_DOCS_PILOT_WORKSPACE_ID", "other");
  vi.stubEnv("VERCEL_ENV", "preview"); vi.stubEnv("PREVIEW_AUTOMATION_ENABLED", "1");
  expect(() => isDocumentPilotWorkspace("other")).toThrow(/workspace/);
});
it.each([null, { id: "run", workspaceId: "workspace", deploymentId: "deployment", revokedAt: new Date(), expiresAt: new Date(Date.now() + 60000) },
  { id: "run", workspaceId: "workspace", deploymentId: "deployment", revokedAt: null, expiresAt: new Date(0) }])("refuses storage for an absent/revoked/expired run", async (run) => {
  vi.stubEnv("GEODE_DOCS_PILOT_WORKSPACE_ID", "workspace");
  vi.stubEnv("VERCEL_ENV", "preview"); vi.stubEnv("PREVIEW_AUTOMATION_ENABLED", "1");
  state.run.mockResolvedValue(run);
  await expect(getDocumentStore("workspace")).rejects.toThrow("Managed pilot run unavailable");
});
