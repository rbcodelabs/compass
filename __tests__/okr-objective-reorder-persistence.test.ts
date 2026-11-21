import { beforeEach, describe, expect, it, vi } from "vitest";

type ObjectiveRow = { id: string; cycleId: string; workspaceId: string; sortOrder: number };
const objectiveRows = vi.hoisted(() => ({ rows: [] as ObjectiveRow[] }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/product-action-auth", () => ({
  requireProductEntity: vi.fn().mockResolvedValue({ workspaceId: "ws-1", opportunityId: null }),
  requireProductWorkspace: vi.fn(),
  requireProductWorkspaceBySlug: vi.fn(),
}));
vi.mock("@/lib/db", () => {
  const client = {
    objective: {
      findFirst: async ({ where }: { where: { id: string; workspaceId: string } }) =>
        objectiveRows.rows.find((r) => r.id === where.id && r.workspaceId === where.workspaceId) ?? null,
      findMany: async ({ where }: { where: { cycleId: string; workspaceId: string } }) =>
        objectiveRows.rows.filter((r) => r.cycleId === where.cycleId && r.workspaceId === where.workspaceId)
          .sort((a, b) => a.sortOrder - b.sortOrder).map((r) => ({ ...r })),
      update: async ({ where, data }: { where: { id: string }; data: { sortOrder: number } }) => {
        objectiveRows.rows.find((r) => r.id === where.id)!.sortOrder = data.sortOrder;
      },
    },
  };
  return { default: () => ({ ...client, $transaction: async (fn: (tx: typeof client) => Promise<unknown>) => fn(client) }) };
});

import { reorderObjective } from "@/app/[orgSlug]/[workspaceSlug]/okrs/actions";

describe("reorderObjective", () => {
  beforeEach(() => {
    objectiveRows.rows = [
      { id: "A", cycleId: "cycle", workspaceId: "ws-1", sortOrder: 0 },
      { id: "B", cycleId: "cycle", workspaceId: "ws-1", sortOrder: 1 },
      { id: "C", cycleId: "cycle", workspaceId: "ws-1", sortOrder: 2 },
      { id: "Foreign", cycleId: "cycle", workspaceId: "other", sortOrder: 0 },
    ];
  });

  it("persists the order of the full cycle when a filtered list drops one objective after another", async () => {
    await reorderObjective("A", { anchorId: "C", position: "after" }, "/p");
    const ranks = Object.fromEntries(objectiveRows.rows.map(({ id, sortOrder }) => [id, sortOrder]));
    expect(ranks).toEqual({ A: 2, B: 0, C: 1, Foreign: 0 });
  });

  it("rejects an anchor outside the workspace", async () => {
    await expect(reorderObjective("C", { anchorId: "Foreign", position: "before" }, "/p")).rejects.toThrow("Not found");
  });
});
