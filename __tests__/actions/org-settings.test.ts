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
// `findMany` is used by createWorkspace's shared service to seed workspace
// membership from the org's members; `findFirst` is resolveOrgAdmin's gate.
const mockOrganizationMember = { findFirst: vi.fn(), findMany: vi.fn() };
const mockOrganization = { findUnique: vi.fn() };
const mockWorkspace = { findFirst: vi.fn(), create: vi.fn() };
const mockWorkspaceMember = { createMany: vi.fn() };

const mockPrisma = {
  scoringModel: mockScoringModel,
  scoringModelMetric: mockScoringModelMetric,
  organizationMember: mockOrganizationMember,
  organization: mockOrganization,
  workspace: mockWorkspace,
  workspaceMember: mockWorkspaceMember,
};

vi.mock("@/lib/db", () => ({
  default: vi.fn(() => mockPrisma),
}));

const mockRevalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

import { auth } from "@/auth";
import {
  createScoringModel,
  createWorkspace,
  updateScoringModelDetails,
  updateScoringModelMetrics,
  archiveScoringModel,
} from "@/app/[orgSlug]/settings/actions";

const mockAuth = vi.mocked(auth);

const weightedSumMetrics = [
  { key: "reach", label: "Reach", minValue: 0, maxValue: 10, weight: 1, direction: "POSITIVE" as const },
  { key: "effort", label: "Effort", minValue: 0, maxValue: 10, weight: 1, direction: "NEGATIVE" as const },
];

/** Shaped like a Prisma unique-constraint violation. */
function uniqueConstraintError() {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1" } } as ReturnType<typeof auth> extends Promise<infer T>
    ? T
    : never);
  mockOrganizationMember.findFirst.mockResolvedValue({ role: "ADMIN", organizationId: "org-1" });
  mockScoringModel.create.mockResolvedValue({ id: "model-1", version: 1 });
  mockScoringModelMetric.createMany.mockResolvedValue({ count: 2 });
  mockScoringModelMetric.deleteMany.mockResolvedValue({ count: 0 });
  mockScoringModel.findUnique.mockResolvedValue({ formulaType: "WEIGHTED_SUM", version: 1 });
  mockScoringModel.update.mockResolvedValue({ id: "model-1" });
  mockOrganization.findUnique.mockResolvedValue({ id: "org-1", name: "Acme" });
  mockWorkspace.findFirst.mockResolvedValue(null);
  mockWorkspace.create.mockResolvedValue({
    id: "ws-1",
    name: "Product Team",
    slug: "product-team",
    description: null,
  });
  mockOrganizationMember.findMany.mockResolvedValue([{ userId: "user-1", role: "OWNER" }]);
  mockWorkspaceMember.createMany.mockResolvedValue({ count: 1 });
});

// ─── createWorkspace ───────────────────────────────────────────────────────

describe("createWorkspace", () => {
  it("creates the workspace and returns the workspace plus its landing route", async () => {
    const result = await createWorkspace("acme", {
      name: "  Product Team  ",
      slug: "product-team",
      description: "  Core product  ",
    });

    expect(result).toEqual({
      ok: true,
      workspace: { id: "ws-1", name: "Product Team", slug: "product-team", description: null },
      // Matches the workspace links rendered on /dashboard.
      redirectTo: "/acme/product-team/okrs",
    });
    expect(mockWorkspace.create).toHaveBeenCalledWith({
      data: {
        organizationId: "org-1",
        name: "Product Team",
        slug: "product-team",
        description: "Core product",
      },
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/settings");
  });

  it("seeds workspace membership for every org member with normalized roles", async () => {
    mockOrganizationMember.findMany.mockResolvedValue([
      { userId: "user-owner", role: "OWNER" },
      { userId: "user-admin", role: "ADMIN" },
      { userId: "user-member", role: "MEMBER" },
      { userId: "user-legacy", role: "owner" },
    ]);

    await createWorkspace("acme", { name: "Product Team", slug: "product-team" });

    expect(mockWorkspaceMember.createMany).toHaveBeenCalledWith({
      data: [
        { workspaceId: "ws-1", userId: "user-owner", role: "ADMIN" },
        { workspaceId: "ws-1", userId: "user-admin", role: "ADMIN" },
        { workspaceId: "ws-1", userId: "user-member", role: "MEMBER" },
        { workspaceId: "ws-1", userId: "user-legacy", role: "ADMIN" },
      ],
      skipDuplicates: true,
    });
    const seeded = mockWorkspaceMember.createMany.mock.calls[0][0].data as Array<{ role: string }>;
    expect(seeded.map((d) => d.role)).not.toContain("OWNER");
  });

  // Returned, never thrown — Next replaces a thrown action error's message in
  // production builds, so a throw here would reach the form as boilerplate.
  it("returns the duplicate-slug failure as data", async () => {
    mockWorkspace.findFirst.mockResolvedValue({ id: "existing-ws" });

    await expect(createWorkspace("acme", { name: "Dup", slug: "product-team" })).resolves.toEqual({
      ok: false,
      error: 'A workspace with slug "product-team" already exists in organization "Acme".',
    });
    expect(mockWorkspace.create).not.toHaveBeenCalled();
  });

  it("returns a clean error when the org does not resolve for the caller", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue(null);

    await expect(
      createWorkspace("nonexistent", { name: "Product Team", slug: "product-team" })
    ).resolves.toEqual({ ok: false, error: "Organization not found" });
    expect(mockWorkspace.create).not.toHaveBeenCalled();
  });

  it("returns a clean error when the org row itself is missing", async () => {
    // resolveOrgAdmin passes (a membership row exists) but the organization is
    // gone — relationMode="prisma" means no FK stops that.
    mockOrganization.findUnique.mockResolvedValue(null);

    await expect(
      createWorkspace("acme", { name: "Product Team", slug: "product-team" })
    ).resolves.toEqual({ ok: false, error: 'No organization found with slug "acme".' });
    expect(mockWorkspace.create).not.toHaveBeenCalled();
  });

  it("rejects a non-admin caller without writing anything", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue({ role: "MEMBER", organizationId: "org-1" });

    await expect(
      createWorkspace("acme", { name: "Product Team", slug: "product-team" })
    ).resolves.toEqual({ ok: false, error: "Forbidden: organization admin required" });
    expect(mockWorkspace.create).not.toHaveBeenCalled();
    expect(mockWorkspaceMember.createMany).not.toHaveBeenCalled();
  });

  it("rejects a caller who is not signed in", async () => {
    mockAuth.mockResolvedValue(null as never);

    await expect(
      createWorkspace("acme", { name: "Product Team", slug: "product-team" })
    ).resolves.toEqual({ ok: false, error: "You are not signed in." });
    expect(mockWorkspace.create).not.toHaveBeenCalled();
  });

  it("rejects a slug outside /^[a-z0-9-]+$/ — the client pattern is a hint, not a boundary", async () => {
    await expect(
      createWorkspace("acme", { name: "Product Team", slug: "Product Team!" })
    ).resolves.toEqual({
      ok: false,
      error: "Slug may only contain lowercase letters, numbers, and hyphens.",
    });
    expect(mockWorkspace.create).not.toHaveBeenCalled();
  });

  it("rejects an empty name and an empty slug", async () => {
    await expect(createWorkspace("acme", { name: "   ", slug: "product-team" })).resolves.toEqual({
      ok: false,
      error: "Workspace name is required.",
    });
    await expect(createWorkspace("acme", { name: "Product Team", slug: "  " })).resolves.toEqual({
      ok: false,
      error: "URL slug is required.",
    });
    expect(mockWorkspace.create).not.toHaveBeenCalled();
  });
});

// ─── createScoringModel ────────────────────────────────────────────────────

describe("createScoringModel", () => {
  it("creates the model then its metrics in declared order", async () => {
    const result = await createScoringModel("org", {
      name: "RICE",
      formulaType: "WEIGHTED_SUM",
      metrics: weightedSumMetrics,
    });

    expect(result).toEqual({ ok: true, model: { id: "model-1", version: 1 } });
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
    const result = await createScoringModel("org", {
      name: "Empty",
      formulaType: "WEIGHTED_SUM",
      metrics: [],
    });
    expect(result.ok).toBe(true);
    expect(mockScoringModelMetric.createMany).not.toHaveBeenCalled();
  });

  // ── Validation failures come back as values, not throws ──────────────────
  //
  // This is the whole point of the fix: a *thrown* Server Action error has its
  // message replaced by Next in production builds, so the specific reason
  // never reaches the form. `.rejects.toThrow()` here would mean the bug is
  // back.

  it("returns (does not throw) when a MULTIPLICATIVE metric has minValue <= 0", async () => {
    const promise = createScoringModel("org", {
      name: "RICE",
      formulaType: "MULTIPLICATIVE",
      metrics: [
        { key: "reach", label: "Reach", minValue: 0, maxValue: 1000, weight: 1, direction: "POSITIVE" },
      ],
    });

    await expect(promise).resolves.toBeDefined();
    const result = await promise;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toMatch(/minValue greater than 0/);
    expect(result.issues).toEqual([
      expect.objectContaining({ index: 0, field: "minValue", metricKey: "reach" }),
    ]);
    // No orphan rows: validation precedes every write.
    expect(mockScoringModel.create).not.toHaveBeenCalled();
    expect(mockScoringModelMetric.createMany).not.toHaveBeenCalled();
  });

  it("rejects duplicate metric keys, naming the key, before writing anything", async () => {
    const result = await createScoringModel("org", {
      name: "RICE",
      formulaType: "WEIGHTED_SUM",
      metrics: [
        { key: "reach", label: "Reach", minValue: 0, maxValue: 10, weight: 1, direction: "POSITIVE" },
        { key: "reach", label: "Reach again", minValue: 0, maxValue: 10, weight: 1, direction: "NEGATIVE" },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain('"reach"');
    expect(result.issues).toEqual([
      expect.objectContaining({ index: 1, field: "key", metricKey: "reach" }),
    ]);
    // The pre-existing bug: the parent model row was created and *then*
    // createMany tripped the unique index, leaving a model with zero metrics.
    expect(mockScoringModel.create).not.toHaveBeenCalled();
    expect(mockScoringModelMetric.createMany).not.toHaveBeenCalled();
  });

  it("rejects a blank metric key before writing anything", async () => {
    const result = await createScoringModel("org", {
      name: "RICE",
      formulaType: "WEIGHTED_SUM",
      metrics: [
        { key: "", label: "Nameless", minValue: 0, maxValue: 10, weight: 1, direction: "POSITIVE" },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toMatch(/needs a key/);
    expect(mockScoringModel.create).not.toHaveBeenCalled();
  });

  it("accepts MULTIPLICATIVE models where every metric has minValue > 0", async () => {
    const result = await createScoringModel("org", {
      name: "True RICE",
      formulaType: "MULTIPLICATIVE",
      metrics: [
        { key: "reach", label: "Reach", minValue: 1, maxValue: 1000, weight: 1, direction: "POSITIVE" },
        { key: "effort", label: "Effort", minValue: 0.5, maxValue: 10, weight: 1, direction: "NEGATIVE" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(mockScoringModel.create).toHaveBeenCalled();
  });

  // ── Permission failures come back as values too ──────────────────────────

  it("returns a clean error when the session is missing", async () => {
    mockAuth.mockResolvedValue(null as never);
    const result = await createScoringModel("org", {
      name: "RICE",
      formulaType: "WEIGHTED_SUM",
      metrics: [],
    });

    expect(result).toEqual({ ok: false, error: "You are not signed in." });
    expect(mockScoringModel.create).not.toHaveBeenCalled();
  });

  it("returns a clean error when the caller is not an org member", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue(null);
    const result = await createScoringModel("org", {
      name: "RICE",
      formulaType: "WEIGHTED_SUM",
      metrics: [],
    });
    expect(result).toEqual({ ok: false, error: "Organization not found" });
  });

  it("returns a clean error when the caller is a MEMBER, not an org admin", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue({ role: "MEMBER", organizationId: "org-1" });
    const result = await createScoringModel("org", {
      name: "RICE",
      formulaType: "WEIGHTED_SUM",
      metrics: [],
    });

    expect(result).toEqual({ ok: false, error: "Forbidden: organization admin required" });
    expect(mockScoringModel.create).not.toHaveBeenCalled();
  });

  // ── Unexpected faults still fail loudly ──────────────────────────────────

  it("rethrows an unexpected database fault rather than returning it as a friendly string", async () => {
    mockScoringModel.create.mockRejectedValue(new Error("connection terminated unexpectedly"));

    await expect(
      createScoringModel("org", { name: "RICE", formulaType: "WEIGHTED_SUM", metrics: [] })
    ).rejects.toThrow("connection terminated unexpectedly");
  });

  it("still converts a unique-constraint violation to a result (defence in depth)", async () => {
    // Unreachable through the form now that keys are validated up front, but
    // a concurrent create could still race into the unique index.
    mockScoringModelMetric.createMany.mockRejectedValue(uniqueConstraintError());

    const result = await createScoringModel("org", {
      name: "RICE",
      formulaType: "WEIGHTED_SUM",
      metrics: weightedSumMetrics,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toMatch(/unique/i);
  });
});

// ─── updateScoringModelDetails ─────────────────────────────────────────────

describe("updateScoringModelDetails", () => {
  it("updates name/description without touching version", async () => {
    const result = await updateScoringModelDetails("org", "model-1", { name: "New name" });

    expect(result).toEqual({ ok: true });
    expect(mockScoringModel.update).toHaveBeenCalledWith({
      where: { id: "model-1" },
      data: { name: "New name", updatedAt: expect.any(Date) },
    });
    const data = mockScoringModel.update.mock.calls[0][0].data;
    expect(data.version).toBeUndefined();
  });

  it("returns a clean error when the session is missing", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(updateScoringModelDetails("org", "model-1", { name: "X" })).resolves.toEqual({
      ok: false,
      error: "You are not signed in.",
    });
  });

  it("returns a clean error when the caller is not an org admin", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue({ role: "MEMBER", organizationId: "org-1" });
    await expect(updateScoringModelDetails("org", "model-1", { name: "X" })).resolves.toEqual({
      ok: false,
      error: "Forbidden: organization admin required",
    });
  });
});

// ─── updateScoringModelMetrics ─────────────────────────────────────────────

describe("updateScoringModelMetrics", () => {
  it("replaces metrics and increments version", async () => {
    const result = await updateScoringModelMetrics("org", "model-1", { metrics: weightedSumMetrics });

    expect(result).toEqual({ ok: true });
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
    const result = await updateScoringModelMetrics("org", "model-1", {
      formulaType: "MULTIPLICATIVE",
      metrics: [
        { key: "reach", label: "Reach", minValue: 1, maxValue: 1000, weight: 1, direction: "POSITIVE" },
        { key: "effort", label: "Effort", minValue: 0.5, maxValue: 10, weight: 1, direction: "NEGATIVE" },
      ],
    });

    expect(result.ok).toBe(true);
    const data = mockScoringModel.update.mock.calls[0][0].data;
    expect(data.formulaType).toBe("MULTIPLICATIVE");
  });

  it("returns an issue when switching to MULTIPLICATIVE with a metric at minValue <= 0", async () => {
    const result = await updateScoringModelMetrics("org", "model-1", {
      formulaType: "MULTIPLICATIVE",
      metrics: weightedSumMetrics, // reach has minValue 0
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toMatch(/minValue greater than 0/);
    // Critically: the existing metrics were NOT deleted by the rejected edit.
    expect(mockScoringModelMetric.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects duplicate keys before the destructive deleteMany", async () => {
    const result = await updateScoringModelMetrics("org", "model-1", {
      metrics: [
        { key: "reach", label: "Reach", minValue: 0, maxValue: 10, weight: 1, direction: "POSITIVE" },
        { key: "reach", label: "Dup", minValue: 0, maxValue: 10, weight: 1, direction: "POSITIVE" },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain('"reach"');
    expect(mockScoringModelMetric.deleteMany).not.toHaveBeenCalled();
  });

  it("returns Scoring model not found when the model does not exist", async () => {
    mockScoringModel.findUnique.mockResolvedValue(null);
    await expect(
      updateScoringModelMetrics("org", "missing", { metrics: weightedSumMetrics })
    ).resolves.toEqual({ ok: false, error: "Scoring model not found" });
  });

  it("returns a clean error when the session is missing", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(
      updateScoringModelMetrics("org", "model-1", { metrics: weightedSumMetrics })
    ).resolves.toEqual({ ok: false, error: "You are not signed in." });
  });
});

// ─── archiveScoringModel ────────────────────────────────────────────────────

describe("archiveScoringModel", () => {
  it("sets status ARCHIVED and updatedAt", async () => {
    const result = await archiveScoringModel("org", "model-1");

    expect(result).toEqual({ ok: true });
    expect(mockScoringModel.update).toHaveBeenCalledWith({
      where: { id: "model-1" },
      data: { status: "ARCHIVED", updatedAt: expect.any(Date) },
    });
  });

  it("returns a clean error when the session is missing", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(archiveScoringModel("org", "model-1")).resolves.toEqual({
      ok: false,
      error: "You are not signed in.",
    });
    expect(mockScoringModel.update).not.toHaveBeenCalled();
  });

  it("returns a clean error when the caller is not an org admin", async () => {
    mockOrganizationMember.findFirst.mockResolvedValue({ role: "MEMBER", organizationId: "org-1" });
    await expect(archiveScoringModel("org", "model-1")).resolves.toEqual({
      ok: false,
      error: "Forbidden: organization admin required",
    });
  });
});
