/**
 * Unit tests for the roadmap-item panel's Launch server actions
 * (app/[orgSlug]/[workspaceSlug]/roadmap/launch-actions.ts): the session guard,
 * the workspace-scoped ownership checks, the already-launching guard, and that
 * a successful write revalidates the given path. The shared core is mocked so
 * these tests exercise only the action layer's own logic (the core itself is
 * covered by launch-checklist.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRoadmapItem = { findFirst: vi.fn(), findUniqueOrThrow: vi.fn() };
const mockLaunchChecklistItem = { findFirst: vi.fn() };
const mockWorkspaceMember = { findUnique: vi.fn() };
const mockPrisma = { roadmapItem: mockRoadmapItem, launchChecklistItem: mockLaunchChecklistItem, workspaceMember: mockWorkspaceMember };

vi.mock("@/lib/db", () => ({ default: () => mockPrisma }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/launch-checklist", () => ({
  resolveOrSeedTemplate: vi.fn(),
  setLaunchTierCore: vi.fn(),
  updateChecklistItemCore: vi.fn(),
  assertLaunchWorkflowEnabled: vi.fn(),
  LAUNCH_WORKFLOW_DISABLED_MESSAGE: "The marketing launch workflow is disabled for this workspace. A workspace admin can turn it on in Settings → Marketing launch.",
}));

import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import {
  resolveOrSeedTemplate,
  setLaunchTierCore,
  updateChecklistItemCore,
  assertLaunchWorkflowEnabled,
} from "@/lib/launch-checklist";
import {
  setLaunchTier,
  updateLaunchChecklistItem,
} from "@/app/[orgSlug]/[workspaceSlug]/roadmap/launch-actions";

const mockAuth = vi.mocked(auth);
const WS = "ws-1";
const ITEM_ID = "item-1";

type Session = ReturnType<typeof auth> extends Promise<infer T> ? T : never;

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1" } } as Session);
  mockWorkspaceMember.findUnique.mockResolvedValue({ id: "member-1" });
  mockRoadmapItem.findFirst.mockResolvedValue({ id: ITEM_ID, horizon: "NOW" });
  mockRoadmapItem.findUniqueOrThrow.mockResolvedValue({ id: ITEM_ID, horizon: "LAUNCHING", updatedAt: new Date("2026-09-05T12:00:00.000Z") });
  mockLaunchChecklistItem.findFirst.mockResolvedValue({ id: "lci-1" });
  vi.mocked(resolveOrSeedTemplate).mockResolvedValue({
    id: "tmpl-1",
    name: "Major Launch",
    tier: "TIER_1",
    items: [],
  });
  vi.mocked(setLaunchTierCore).mockResolvedValue({ launchChecklistId: "cl-1", itemCount: 2 });
  vi.mocked(updateChecklistItemCore).mockResolvedValue({ id: "lci-1", label: "x", status: "DONE" });
  vi.mocked(assertLaunchWorkflowEnabled).mockResolvedValue(undefined);
});

// ─── setLaunchTier ───────────────────────────────────────────────────────────

describe("setLaunchTier", () => {
  it("throws Unauthorized when there is no session", async () => {
    mockAuth.mockResolvedValueOnce(null as unknown as Session);
    await expect(setLaunchTier(ITEM_ID, "TIER_1", WS)).rejects.toThrow("Unauthorized");
    expect(setLaunchTierCore).not.toHaveBeenCalled();
  });

  it("throws when the roadmap item isn't in the workspace", async () => {
    mockRoadmapItem.findFirst.mockResolvedValueOnce(null);
    await expect(setLaunchTier(ITEM_ID, "TIER_1", WS)).rejects.toThrow("Roadmap item not found");
    expect(setLaunchTierCore).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects an authenticated non-member before resolving or mutating an item", async () => {
    mockWorkspaceMember.findUnique.mockResolvedValueOnce(null);
    await expect(setLaunchTier(ITEM_ID, "TIER_1", WS)).rejects.toThrow("Workspace not found");
    expect(mockRoadmapItem.findFirst).not.toHaveBeenCalled();
    expect(setLaunchTierCore).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects an item that is already LAUNCHING without writing", async () => {
    mockRoadmapItem.findFirst.mockResolvedValueOnce({ id: ITEM_ID, horizon: "LAUNCHING" });
    await expect(setLaunchTier(ITEM_ID, "TIER_1", WS)).rejects.toThrow(/already LAUNCHING/);
    expect(setLaunchTierCore).not.toHaveBeenCalled();
  });

  it("rejects an item that is already LAUNCHED without writing", async () => {
    mockRoadmapItem.findFirst.mockResolvedValueOnce({ id: ITEM_ID, horizon: "LAUNCHED" });
    await expect(setLaunchTier(ITEM_ID, "TIER_1", WS)).rejects.toThrow(/already LAUNCHED/);
    expect(setLaunchTierCore).not.toHaveBeenCalled();
  });

  it("resolves the template, runs the core, and revalidates on success", async () => {
    await setLaunchTier(ITEM_ID, "TIER_1", WS);
    expect(resolveOrSeedTemplate).toHaveBeenCalledWith(WS, "TIER_1");
    expect(setLaunchTierCore).toHaveBeenCalledWith(ITEM_ID, "TIER_1", expect.objectContaining({ id: "tmpl-1" }), WS);
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("scopes the item lookup to the workspace", async () => {
    await setLaunchTier(ITEM_ID, "TIER_1", WS);
    expect(mockRoadmapItem.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ITEM_ID, workspaceId: WS } })
    );
  });
});

// ─── updateLaunchChecklistItem ───────────────────────────────────────────────

describe("updateLaunchChecklistItem", () => {
  it("throws Unauthorized when there is no session", async () => {
    mockAuth.mockResolvedValueOnce(null as unknown as Session);
    await expect(updateLaunchChecklistItem("lci-1", "DONE", WS)).rejects.toThrow("Unauthorized");
    expect(updateChecklistItemCore).not.toHaveBeenCalled();
  });

  it("throws when the checklist item isn't owned by the workspace", async () => {
    mockLaunchChecklistItem.findFirst.mockResolvedValueOnce(null);
    await expect(updateLaunchChecklistItem("lci-1", "DONE", WS)).rejects.toThrow("Checklist item not found");
    expect(updateChecklistItemCore).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects an authenticated non-member before resolving or mutating a checklist item", async () => {
    mockWorkspaceMember.findUnique.mockResolvedValueOnce(null);
    await expect(updateLaunchChecklistItem("lci-1", "DONE", WS)).rejects.toThrow("Workspace not found");
    expect(mockLaunchChecklistItem.findFirst).not.toHaveBeenCalled();
    expect(updateChecklistItemCore).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("scopes ownership through the checklist → roadmapItem → workspace chain", async () => {
    await updateLaunchChecklistItem("lci-1", "DONE", WS);
    expect(mockLaunchChecklistItem.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "lci-1", launchChecklist: { roadmapItem: { workspaceId: WS } } },
      })
    );
  });

  it("runs the core and revalidates on success", async () => {
    await updateLaunchChecklistItem("lci-1", "DONE", WS);
    expect(updateChecklistItemCore).toHaveBeenCalledWith("lci-1", "DONE");
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("propagates the disabled-feature rejection and does not write", async () => {
    vi.mocked(assertLaunchWorkflowEnabled).mockRejectedValueOnce(
      new Error("The marketing launch workflow is disabled for this workspace. A workspace admin can turn it on in Settings → Marketing launch.")
    );
    await expect(updateLaunchChecklistItem("lci-1", "DONE", WS)).rejects.toThrow(/disabled for this workspace/);
    expect(updateChecklistItemCore).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
