/** The two fields the Product Spec Canvas added to updateEntityField: assumption risk level and experiment hypothesis. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const models = {
  assumption: { findFirst: vi.fn(), update: vi.fn() },
  experiment: { findFirst: vi.fn(), update: vi.fn() },
};
const database = { ...models, $transaction: vi.fn() };
vi.mock("@/lib/db", () => ({ default: () => database }));
vi.mock("@/lib/roadmap/solution-sync", () => ({ syncRoadmapOnSolutionChange: vi.fn() }));
vi.mock("@/lib/task-assignment", () => ({ assignmentUpdate: vi.fn() }));

import { updateEntityField } from "@/lib/entity-mutations";

const WS = "ws-1";
beforeEach(() => {
  vi.clearAllMocks();
  for (const m of Object.values(models)) m.findFirst.mockResolvedValue({ id: "e1" });
  database.$transaction.mockImplementation((fn: (value: typeof database) => unknown) => fn(database));
});

describe("assumption riskLevel", () => {
  it.each(["HIGH", "MEDIUM", "LOW"])("saves %s after the workspace-scoped existence check", async (level) => {
    expect(await updateEntityField("assumption", "e1", WS, "riskLevel", level)).toEqual({ ok: true });
    expect(models.assumption.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "e1" }) }));
    expect(models.assumption.update.mock.calls[0][0].data).toMatchObject({ riskLevel: level });
  });
  it("rejects an unknown level and a non-string without writing", async () => {
    expect(await updateEntityField("assumption", "e1", WS, "riskLevel", "EXTREME")).toEqual({ ok: false, status: 400, error: "Invalid riskLevel" });
    expect((await updateEntityField("assumption", "e1", WS, "riskLevel", null)).ok).toBe(false);
    expect(models.assumption.update).not.toHaveBeenCalled();
  });
  it("is not an editable field on other entities", async () => {
    expect((await updateEntityField("experiment", "e1", WS, "riskLevel", "HIGH")).ok).toBe(false);
  });
  it("404s when the assumption is outside the workspace", async () => {
    models.assumption.findFirst.mockResolvedValue(null);
    expect(await updateEntityField("assumption", "e1", WS, "riskLevel", "LOW")).toEqual({ ok: false, status: 404, error: "Not found" });
    expect(models.assumption.update).not.toHaveBeenCalled();
  });
});

describe("experiment hypothesis", () => {
  it("trims and saves", async () => {
    expect(await updateEntityField("experiment", "e1", WS, "hypothesis", "  We believe X  ")).toEqual({ ok: true });
    expect(models.experiment.update.mock.calls[0][0].data.hypothesis).toBe("We believe X");
  });
  it("requires text", async () => {
    expect(await updateEntityField("experiment", "e1", WS, "hypothesis", "  ")).toEqual({ ok: false, status: 400, error: "Hypothesis is required" });
    expect(models.experiment.update).not.toHaveBeenCalled();
  });
});
