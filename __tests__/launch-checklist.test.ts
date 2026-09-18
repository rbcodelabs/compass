/**
 * Unit tests for the plain-data Launch Tiers + Checklist core
 * (lib/launch-checklist.ts) shared by the MCP tool handlers and the web
 * server actions. Prisma is mocked; these tests pin the transactional shape of
 * setLaunchTierCore, the idempotent auto-seed of resolveOrSeedTemplate, the
 * completedAt bookkeeping of updateChecklistItemCore, and the progress rollup.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRoadmapItem = { update: vi.fn() };
const mockCapacityReservation = { findUnique: vi.fn(), update: vi.fn() };
const mockCapacityPlan = { updateMany: vi.fn() };
const mockChecklistTemplate = { findFirst: vi.fn(), create: vi.fn() };
const mockChecklistTemplateItem = { createMany: vi.fn() };
const mockLaunchChecklist = { create: vi.fn() };
const mockLaunchChecklistItem = {
  createMany: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
};
const mockWorkspace = { findUnique: vi.fn() };

const mockPrisma = {
  roadmapItem: mockRoadmapItem,
  checklistTemplate: mockChecklistTemplate,
  checklistTemplateItem: mockChecklistTemplateItem,
  launchChecklist: mockLaunchChecklist,
  launchChecklistItem: mockLaunchChecklistItem,
  portfolioCapacityReservation: mockCapacityReservation,
  portfolioCapacityPlan: mockCapacityPlan,
  workspace: mockWorkspace,
  // Array-form $transaction, matching the real client's behaviour when passed
  // an array of operations (not the interactive-callback form).
  $transaction: vi.fn(),
};

vi.mock("@/lib/db", () => ({ default: () => mockPrisma }));

import {
  resolveOrSeedTemplate,
  setLaunchTierCore,
  updateChecklistItemCore,
  checklistProgress,
  assertLaunchWorkflowEnabled,
  LAUNCH_WORKFLOW_DISABLED_MESSAGE,
  type ResolvedTemplate,
} from "@/lib/launch-checklist";
import { DEFAULT_CHECKLIST_TEMPLATES } from "@/lib/launch-defaults";

const WORKSPACE_ID = "ws-1";
const ITEM_ID = "item-1";
const TEMPLATE_ID = "template-1";
const CHECKLIST_ID = "checklist-1";

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.$transaction.mockImplementation((operation: Promise<unknown>[] | ((database: typeof mockPrisma) => unknown)) => Array.isArray(operation) ? Promise.all(operation) : operation(mockPrisma));
  mockCapacityReservation.findUnique.mockResolvedValue(null);
  mockLaunchChecklist.create.mockResolvedValue({ id: CHECKLIST_ID });
  mockLaunchChecklistItem.createMany.mockResolvedValue({ count: 0 });
  mockChecklistTemplateItem.createMany.mockResolvedValue({ count: 0 });
  mockRoadmapItem.update.mockResolvedValue({ id: ITEM_ID, horizon: "LAUNCHING" });
  // Default every test to a workspace with the launch workflow turned on —
  // the specific "disabled" behavior gets its own describe block below.
  mockWorkspace.findUnique.mockResolvedValue({ launchWorkflowEnabled: true });
});

// ─── assertLaunchWorkflowEnabled ─────────────────────────────────────────────

describe("assertLaunchWorkflowEnabled", () => {
  it("resolves when the workspace has the launch workflow on", async () => {
    mockWorkspace.findUnique.mockResolvedValueOnce({ launchWorkflowEnabled: true });
    await expect(assertLaunchWorkflowEnabled(WORKSPACE_ID)).resolves.toBeUndefined();
  });

  it("throws the shared disabled-feature message when off", async () => {
    mockWorkspace.findUnique.mockResolvedValueOnce({ launchWorkflowEnabled: false });
    await expect(assertLaunchWorkflowEnabled(WORKSPACE_ID)).rejects.toThrow(LAUNCH_WORKFLOW_DISABLED_MESSAGE);
  });

  it("throws when the workspace has never set the flag (null)", async () => {
    mockWorkspace.findUnique.mockResolvedValueOnce({ launchWorkflowEnabled: null });
    await expect(assertLaunchWorkflowEnabled(WORKSPACE_ID)).rejects.toThrow(LAUNCH_WORKFLOW_DISABLED_MESSAGE);
  });
});

// ─── resolveOrSeedTemplate ───────────────────────────────────────────────────

describe("resolveOrSeedTemplate", () => {
  it("returns the workspace's existing active template without seeding", async () => {
    mockChecklistTemplate.findFirst.mockResolvedValueOnce({
      id: TEMPLATE_ID,
      name: "Custom Launch",
      tier: "TIER_1",
      items: [
        { label: "A", description: null, order: 0 },
        { label: "B", description: "b", order: 1 },
      ],
    });

    const result = await resolveOrSeedTemplate(WORKSPACE_ID, "TIER_1");

    expect(result.id).toBe(TEMPLATE_ID);
    expect(result.name).toBe("Custom Launch");
    expect(result.items).toHaveLength(2);
    expect(mockChecklistTemplate.create).not.toHaveBeenCalled();
    expect(mockChecklistTemplateItem.createMany).not.toHaveBeenCalled();
  });

  it("seeds the tier's default template + items when none exists yet", async () => {
    mockChecklistTemplate.findFirst.mockResolvedValueOnce(null);
    mockChecklistTemplate.create.mockResolvedValueOnce({
      id: TEMPLATE_ID,
      name: DEFAULT_CHECKLIST_TEMPLATES.TIER_2.name,
    });

    const result = await resolveOrSeedTemplate(WORKSPACE_ID, "TIER_2");

    expect(mockChecklistTemplate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        tier: "TIER_2",
        name: DEFAULT_CHECKLIST_TEMPLATES.TIER_2.name,
      }),
    });
    // TIER_2 default has 4 items, seeded with sequential order.
    const seeded = mockChecklistTemplateItem.createMany.mock.calls[0][0].data;
    expect(seeded).toHaveLength(DEFAULT_CHECKLIST_TEMPLATES.TIER_2.items.length);
    expect(seeded.map((i: { order: number }) => i.order)).toEqual([0, 1, 2, 3]);
    expect(result.id).toBe(TEMPLATE_ID);
    expect(result.tier).toBe("TIER_2");
    expect(result.items).toHaveLength(DEFAULT_CHECKLIST_TEMPLATES.TIER_2.items.length);
  });

  it("is idempotent: a second call finds the seeded template and does not seed again", async () => {
    // First call: nothing exists → seed.
    mockChecklistTemplate.findFirst.mockResolvedValueOnce(null);
    mockChecklistTemplate.create.mockResolvedValueOnce({
      id: TEMPLATE_ID,
      name: DEFAULT_CHECKLIST_TEMPLATES.TIER_3.name,
    });
    await resolveOrSeedTemplate(WORKSPACE_ID, "TIER_3");
    expect(mockChecklistTemplate.create).toHaveBeenCalledTimes(1);

    // Second call: the seeded template is now the active one → reuse it.
    mockChecklistTemplate.findFirst.mockResolvedValueOnce({
      id: TEMPLATE_ID,
      name: DEFAULT_CHECKLIST_TEMPLATES.TIER_3.name,
      tier: "TIER_3",
      items: DEFAULT_CHECKLIST_TEMPLATES.TIER_3.items.map((item, i) => ({
        label: item.label,
        description: null,
        order: i,
      })),
    });
    const second = await resolveOrSeedTemplate(WORKSPACE_ID, "TIER_3");

    expect(second.id).toBe(TEMPLATE_ID);
    // Still only the single create from the first call — no re-seed.
    expect(mockChecklistTemplate.create).toHaveBeenCalledTimes(1);
  });
});

// ─── setLaunchTierCore ───────────────────────────────────────────────────────

describe("setLaunchTierCore", () => {
  const template: ResolvedTemplate = {
    id: TEMPLATE_ID,
    name: "Major Launch",
    tier: "TIER_1",
    items: [
      { label: "Announce", description: null, order: 0 },
      { label: "Brief support", description: "notes", order: 1 },
    ],
  };

  it("creates the checklist, then its items, then flips horizon — in one transaction, in order", async () => {
    const order: string[] = [];
    mockLaunchChecklist.create.mockImplementation(() => {
      order.push("launchChecklist.create");
      return Promise.resolve({ id: CHECKLIST_ID });
    });
    mockLaunchChecklistItem.createMany.mockImplementation(() => {
      order.push("launchChecklistItem.createMany");
      return Promise.resolve({ count: 2 });
    });
    mockRoadmapItem.update.mockImplementation(() => {
      order.push("roadmapItem.update");
      return Promise.resolve({ id: ITEM_ID, horizon: "LAUNCHING" });
    });

    const result = await setLaunchTierCore(ITEM_ID, "TIER_1", template, WORKSPACE_ID);

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(typeof mockPrisma.$transaction.mock.calls[0][0]).toBe("function");
    expect(order).toEqual([
      "launchChecklist.create",
      "launchChecklistItem.createMany",
      "roadmapItem.update",
    ]);
    expect(result).toEqual({ launchChecklistId: expect.any(String), itemCount: 2 });
  });

  it("flips the roadmap item to LAUNCHING and sets updatedAt", async () => {
    await setLaunchTierCore(ITEM_ID, "TIER_1", template, WORKSPACE_ID);
    const args = mockRoadmapItem.update.mock.calls[0][0];
    expect(args.where).toEqual({ id: ITEM_ID });
    expect(args.data.horizon).toBe("LAUNCHING");
    expect(args.data.updatedAt).toBeInstanceOf(Date);
  });

  it("persists a template snapshot on the checklist row", async () => {
    await setLaunchTierCore(ITEM_ID, "TIER_1", template, WORKSPACE_ID);
    const data = mockLaunchChecklist.create.mock.calls[0][0].data;
    expect(data.roadmapItemId).toBe(ITEM_ID);
    expect(data.tier).toBe("TIER_1");
    const snapshot = JSON.parse(data.templateSnapshot);
    expect(snapshot.templateId).toBe(TEMPLATE_ID);
    expect(snapshot.items).toHaveLength(2);
  });

  it("rejects with the disabled-feature message and writes nothing when the workspace has the launch workflow off", async () => {
    mockWorkspace.findUnique.mockResolvedValueOnce({ launchWorkflowEnabled: false });
    await expect(setLaunchTierCore(ITEM_ID, "TIER_1", template, WORKSPACE_ID)).rejects.toThrow(
      LAUNCH_WORKFLOW_DISABLED_MESSAGE
    );
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockLaunchChecklist.create).not.toHaveBeenCalled();
  });
});

// ─── updateChecklistItemCore ─────────────────────────────────────────────────

describe("updateChecklistItemCore", () => {
  beforeEach(() => {
    mockLaunchChecklistItem.findUnique.mockResolvedValue({ id: "lci-1", label: "Announce" });
    mockLaunchChecklistItem.update.mockImplementation(({ data }) =>
      Promise.resolve({ id: "lci-1", label: "Announce", status: "PENDING", ...data })
    );
  });

  it("returns null and does not update when the item does not exist", async () => {
    mockLaunchChecklistItem.findUnique.mockResolvedValueOnce(null);
    const result = await updateChecklistItemCore("missing", "DONE");
    expect(result).toBeNull();
    expect(mockLaunchChecklistItem.update).not.toHaveBeenCalled();
  });

  it("sets completedAt when marking DONE", async () => {
    await updateChecklistItemCore("lci-1", "DONE");
    const data = mockLaunchChecklistItem.update.mock.calls[0][0].data;
    expect(data.status).toBe("DONE");
    expect(data.completedAt).toBeInstanceOf(Date);
    expect(data.updatedAt).toBeInstanceOf(Date);
  });

  it("clears completedAt when marking PENDING or SKIPPED", async () => {
    await updateChecklistItemCore("lci-1", "SKIPPED");
    expect(mockLaunchChecklistItem.update.mock.calls[0][0].data.completedAt).toBeNull();

    await updateChecklistItemCore("lci-1", "PENDING");
    expect(mockLaunchChecklistItem.update.mock.calls[1][0].data.completedAt).toBeNull();
  });

  it("returns the updated row's id/label/status", async () => {
    const result = await updateChecklistItemCore("lci-1", "DONE");
    expect(result).toEqual({ id: "lci-1", label: "Announce", status: "DONE" });
  });
});

// ─── checklistProgress ───────────────────────────────────────────────────────

describe("checklistProgress", () => {
  it("counts DONE / SKIPPED / PENDING and the total", () => {
    const progress = checklistProgress([
      { status: "DONE" },
      { status: "DONE" },
      { status: "SKIPPED" },
      { status: "PENDING" },
    ]);
    expect(progress).toEqual({ done: 2, skipped: 1, pending: 1, total: 4 });
  });

  it("returns all-zero counts for an empty checklist", () => {
    expect(checklistProgress([])).toEqual({ done: 0, skipped: 0, pending: 0, total: 0 });
  });
});
