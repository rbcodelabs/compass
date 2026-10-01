import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ auth: vi.fn(), workspace: vi.fn(), experiment: vi.fn(), opportunity: vi.fn(), solution: vi.fn(), objective: vi.fn(), keyResult: vi.fn(), cycle: vi.fn(), squad: vi.fn(), task: vi.fn(), roadmapItem: vi.fn() }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/db", () => ({ default: () => ({ workspace: { findFirst: m.workspace }, experiment: { findFirst: m.experiment }, opportunity: { findFirst: m.opportunity }, solution: { findFirst: m.solution }, objective: { findFirst: m.objective }, keyResult: { findFirst: m.keyResult }, oKRCycle: { findFirst: m.cycle }, squad: { findFirst: m.squad }, roadmapItem: { findFirst: m.roadmapItem }, task: { findFirst: m.task } }) }));
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
it("rejects a reachable solution only when the caller's expected workspace differs from the row's", async () => {
  m.solution.mockResolvedValue({ opportunityId: "opportunity", workspaceId: "actual" });
  // Control: the row is reachable and resolves when the expectation matches...
  await expect(requireProductEntity("solution", "solution", "actual")).resolves.toEqual({ workspaceId: "actual", opportunityId: "opportunity" });
  // ...so this rejection is specifically the workspace mismatch, not a missing row.
  await expect(requireProductEntity("solution", "solution", "foreign")).rejects.toThrow("Entity not found or access denied");
});
it("denies a solution whose own workspaceId is NULL, even with no expected workspace (twin of the mismatch case)", async () => {
  // Same reachable row, same opportunity parent; only the column differs.
  m.solution.mockResolvedValue({ opportunityId: "opportunity", workspaceId: null });
  await expect(requireProductEntity("solution", "solution")).rejects.toThrow("Entity not found or access denied");
  await expect(requireProductEntity("solution", "solution", "actual")).rejects.toThrow("Entity not found or access denied");
});
it("scopes objective and key result through the direct column, with membership in the lookup", async () => {
  m.objective.mockResolvedValue({ workspaceId: "actual" });
  await expect(requireProductEntity("objective", "obj")).resolves.toEqual({ workspaceId: "actual", opportunityId: null });
  expect(m.objective).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "obj", workspace: { members: { some: { userId: "user" } } } } }));
  await expect(requireProductEntity("objective", "obj", "foreign")).rejects.toThrow("Entity not found or access denied");
  m.keyResult.mockResolvedValue({ objective: { workspaceId: "actual" } });
  await expect(requireProductEntity("keyResult", "kr", "actual")).resolves.toEqual({ workspaceId: "actual", opportunityId: null });
  expect(m.keyResult).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "kr", objective: { workspace: { members: { some: { userId: "user" } } } } } }));
  await expect(requireProductEntity("keyResult", "kr", "foreign")).rejects.toThrow("Entity not found or access denied");
});
it("denies an objective, and a key result under it, whose workspaceId is NULL", async () => {
  m.objective.mockResolvedValue({ workspaceId: null });
  await expect(requireProductEntity("objective", "obj")).rejects.toThrow("Entity not found or access denied");
  m.keyResult.mockResolvedValue({ objective: { workspaceId: null } });
  await expect(requireProductEntity("keyResult", "kr")).rejects.toThrow("Entity not found or access denied");
});
it("resolves task, squad and roadmapItem by membership-scoped lookup and checks the expected workspace", async () => {
  for (const [kind, mock] of [["task", m.task], ["squad", m.squad], ["roadmapItem", m.roadmapItem]] as const) {
    mock.mockResolvedValue({ workspaceId: "actual" });
    await expect(requireProductEntity(kind, "id", "actual")).resolves.toEqual({ workspaceId: "actual", opportunityId: null });
    expect(mock).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "id", workspace: { members: { some: { userId: "user" } } } } }));
    await expect(requireProductEntity(kind, "id", "foreign")).rejects.toThrow("Entity not found or access denied");
    mock.mockResolvedValue(null);
    await expect(requireProductEntity(kind, "foreign")).rejects.toThrow("Entity not found or access denied");
  }
});
it("denies objective, key result, cycle and squad when the membership-scoped lookup finds nothing", async () => {
  for (const [kind, mock] of [["objective", m.objective], ["keyResult", m.keyResult], ["okrCycle", m.cycle], ["squad", m.squad]] as const) {
    mock.mockResolvedValue(null);
    await expect(requireProductEntity(kind, "foreign")).rejects.toThrow("Entity not found or access denied");
  }
});
