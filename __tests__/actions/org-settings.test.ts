import { describe, it, expect, vi, beforeEach } from "vitest";

const mockScoringModel = {
  create: vi.fn(),
  update: vi.fn(),
  findUnique: vi.fn(),
};
const mockScoringModelMetric = {
  createMany: vi.fn(),
  deleteMany: vi.fn(),
};
const mockOrganizationMember = { findFirst: vi.fn() };

const mockPrisma = {
  scoringModel: mockScoringModel,
  scoringModelMetric: mockScoringModelMetric,
  organizationMember: mockOrganizationMember,
};

vi.mock("@/lib/db", () => ({
  default: vi.fn(() => mockPrisma),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

import { auth } from "@/auth";
import {
  createScoringModel,
  updateScoringModelDetails,
  updateScoringModelMetrics,
  archiveScoringModel,
} from "@/app/[orgSlug]/settings/actions";

const mockAuth = vi.mocked(auth);

const weightedSumMetrics = [
  { key: "reach", label: "Reach", minValue: 0, maxValue: 10, weight: 1, direction: "POSITIVE" as const },
  { key: "effort", label: "Effort", minValue: 0, maxValue: 10, weight: 1, direction: "NEGATIVE" as const },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1" } } as ReturnType<typeof auth> extends Promise<infer T>
    ? T
    : never);
  mockOrganizationMember.findFirst.mockResolvedValue({ role: "ADMIN", organizationId: "org-1" });
  mockScoringModel.create.mockResolvedValue({ id: "model-1" });
  mockScoringModelMetric.createMany.mockResolvedValue({ count: 2 });
  mockScoringModelMetric.deleteMany.mockResolvedValue({ count: 0 });
  mockScoringModel.findUnique.mockResolvedValue({ formulaType: "WEIGHTED_SUM", version: 1 });
  mockScoringModel.update.mockResolvedValue({ id: "model-1" });
});

// ─── createScoringModel ────────────────────────────────────────────────────

describe("createScoringModel", () => {
  it("creates the model then its metrics in declared order", async () => {
    await createScoringModel("org", {
      name: "RICE",
      formulaType: "WEIGHTED_SUM",
      metrics: weightedSumMetrics,
    });

    expect(mockScoringModel.create).toHaveBeenCalledWith({
      data: {
        organizationId: "org-1",
        name: "RICE",
        description: undefined,
        formulaType: "WEIGHTED_SUM",
      },
    });
    expect(mockScoringModelMetric.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ scoringModelId: "model-1", key: "reach", order: 0 }),
        expect.objectContaining({ scoringModelId: "model-1", key: "effort", order: 1 }),
      ],
    });
  });

  it("skips creating metrics when the array is empty", async () => {
    await createScoringModel("org", { name: "Empty", formulaType: "WEIGHTED_SUM", metrics: [] });
    expect(mockScoringModelMetric.createMany).not.toHaveBeenCalled();
  });

  it("rejects MULTIPLICATIVE models where a metric has minValue <= 0", async () => {
    await expect(
      createScoringModel("org", {
        name: "RICE",
        formulaType: "MULTIPLICATIVE",
        metrics: [
          { key: "reach", label: "Reach", minValue: 0, maxValue: 1000, weight: 1, direction: "POSITIVE" },
        ],
      })
    ).rejects.toThrow(/minValue greater than 0/);
    expect(mockScoringModel.create).not.toHaveBeenCalled();
  });

  it("accepts MULTIPLICATIVE models where every metric has minValue > 0", async () => {
    await createScoringModel("org", {
      name: "True RICE",
      formulaType: "MULTIPLICATIVE",
      metrics: [
        { key: "reach", label: "Reach", minValue: 1, maxValue: 1000, weight: 1, direction: "POSITIVE" },
        { key: "effort", label: "Effort", minValue: 0.5, maxValue: 10, weight: 1, direction: "NEGATIVE" },
      ],
    });
    expect(mockScoringModel.create).toHaveBeenCalled();
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(
      createScoringModel("org", { name: "RICE", formulaType: "WEIGHTED_SUM", metrics: [] })
    ).rejects.toThrow("Unauthorized");
    expect(mockScoringModel.create).not.toHaveBeenCalled();
  });

  it("throws Organization not found when caller is not an org member", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue(null);
    await expect(
      createScoringModel("org", { name: "RICE", formulaType: "WEIGHTED_SUM", metrics: [] })
    ).rejects.toThrow("Organization not found");
  });

  it("throws Forbidden when caller is a MEMBER, not org admin", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue({ role: "MEMBER", organizationId: "org-1" });
    await expect(
      createScoringModel("org", { name: "RICE", formulaType: "WEIGHTED_SUM", metrics: [] })
    ).rejects.toThrow("Forbidden: organization admin required");
    expect(mockScoringModel.create).not.toHaveBeenCalled();
  });
});

// ─── updateScoringModelDetails ─────────────────────────────────────────────

describe("updateScoringModelDetails", () => {
  it("updates name/description without touching version", async () => {
    await updateScoringModelDetails("org", "model-1", { name: "New name" });

    expect(mockScoringModel.update).toHaveBeenCalledWith({
      where: { id: "model-1" },
      data: { name: "New name", updatedAt: expect.any(Date) },
    });
    const data = mockScoringModel.update.mock.calls[0][0].data;
    expect(data.version).toBeUndefined();
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(updateScoringModelDetails("org", "model-1", { name: "X" })).rejects.toThrow(
      "Unauthorized"
    );
  });

  it("throws Forbidden when caller is not an org admin", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue({ role: "MEMBER", organizationId: "org-1" });
    await expect(updateScoringModelDetails("org", "model-1", { name: "X" })).rejects.toThrow(
      "Forbidden: organization admin required"
    );
  });
});

// ─── updateScoringModelMetrics ─────────────────────────────────────────────

describe("updateScoringModelMetrics", () => {
  it("replaces metrics and increments version", async () => {
    await updateScoringModelMetrics("org", "model-1", { metrics: weightedSumMetrics });

    expect(mockScoringModelMetric.deleteMany).toHaveBeenCalledWith({ where: { scoringModelId: "model-1" } });
    expect(mockScoringModelMetric.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ key: "reach", order: 0 }),
        expect.objectContaining({ key: "effort", order: 1 }),
      ],
    });
    expect(mockScoringModel.update).toHaveBeenCalledWith({
      where: { id: "model-1" },
      data: { formulaType: "WEIGHTED_SUM", version: 2, updatedAt: expect.any(Date) },
    });
  });

  it("allows switching formula type as part of a metrics edit", async () => {
    await updateScoringModelMetrics("org", "model-1", {
      formulaType: "MULTIPLICATIVE",
      metrics: [
        { key: "reach", label: "Reach", minValue: 1, maxValue: 1000, weight: 1, direction: "POSITIVE" },
        { key: "effort", label: "Effort", minValue: 0.5, maxValue: 10, weight: 1, direction: "NEGATIVE" },
      ],
    });

    const data = mockScoringModel.update.mock.calls[0][0].data;
    expect(data.formulaType).toBe("MULTIPLICATIVE");
  });

  it("rejects switching to MULTIPLICATIVE if a metric has minValue <= 0", async () => {
    await expect(
      updateScoringModelMetrics("org", "model-1", {
        formulaType: "MULTIPLICATIVE",
        metrics: weightedSumMetrics, // reach has minValue 0
      })
    ).rejects.toThrow(/minValue greater than 0/);
    expect(mockScoringModelMetric.deleteMany).not.toHaveBeenCalled();
  });

  it("throws Scoring model not found when the model does not exist", async () => {
    mockScoringModel.findUnique.mockResolvedValue(null);
    await expect(
      updateScoringModelMetrics("org", "missing", { metrics: weightedSumMetrics })
    ).rejects.toThrow("Scoring model not found");
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(
      updateScoringModelMetrics("org", "model-1", { metrics: weightedSumMetrics })
    ).rejects.toThrow("Unauthorized");
  });
});

// ─── archiveScoringModel ────────────────────────────────────────────────────

describe("archiveScoringModel", () => {
  it("sets status ARCHIVED and updatedAt", async () => {
    await archiveScoringModel("org", "model-1");

    expect(mockScoringModel.update).toHaveBeenCalledWith({
      where: { id: "model-1" },
      data: { status: "ARCHIVED", updatedAt: expect.any(Date) },
    });
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(archiveScoringModel("org", "model-1")).rejects.toThrow("Unauthorized");
    expect(mockScoringModel.update).not.toHaveBeenCalled();
  });

  it("throws Forbidden when caller is not an org admin", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue({ role: "MEMBER", organizationId: "org-1" });
    await expect(archiveScoringModel("org", "model-1")).rejects.toThrow(
      "Forbidden: organization admin required"
    );
  });
});
