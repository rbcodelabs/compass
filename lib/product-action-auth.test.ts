import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ auth: vi.fn(), workspace: vi.fn(), experiment: vi.fn(), opportunity: vi.fn(), solution: vi.fn() }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/db", () => ({ default: () => ({ workspace: { findFirst: m.workspace }, experiment: { findFirst: m.experiment }, opportunity: { findFirst: m.opportunity }, solution: { findFirst: m.solution } }) }));
import { requireProductWorkspace, requireProductEntity } from "./product-action-auth";
beforeEach(() => { vi.clearAllMocks(); m.auth.mockResolvedValue({ user: { id: "user" } }); });
it("requires authentication even without analytics collection", async () => {
  m.auth.mockResolvedValue(null);
  await expect(requireProductWorkspace("ws")).rejects.toThrow("Unauthorized");
  expect(m.workspace).not.toHaveBeenCalled();
});
it("scopes workspace lookup to the authenticated member", async () => {
  m.workspace.mockResolvedValue(null);
  await expect(requireProductWorkspace("foreign")).rejects.toThrow("not found");
  expect(m.workspace).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "foreign", members: { some: { userId: "user" } } } }));
});
it("scopes experiment lookup before any write", async () => {
  m.experiment.mockResolvedValue(null);
  await expect(requireProductEntity("experiment", "foreign")).rejects.toThrow("not found");
  expect(m.experiment).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "foreign", workspace: { members: { some: { userId: "user" } } } } }));
});
it("rejects a valid solution when the caller supplied a different workspace", async () => {
  m.solution.mockResolvedValue({ id: "solution", opportunityId: "opportunity", opportunity: { workspaceId: "actual" } });
  await expect(requireProductEntity("solution", "solution", "foreign")).rejects.toThrow("not found");
});
