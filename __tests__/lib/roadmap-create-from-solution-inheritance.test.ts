import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrisma, solutionRow, type FakeState } from "./roadmap-fake-prisma";

const m = vi.hoisted(() => ({ apply: vi.fn() }));
vi.mock("@/lib/custom-field-inheritance", () => ({ applyInheritanceRules: m.apply, applyInheritanceForSourceValue: vi.fn() }));
vi.mock("@/lib/workspace-update-mutations", () => ({
  captureWorkspaceMutation: async (_prisma: unknown, _model: string, _op: string, _source: unknown, _id: unknown, mutate: (tx: unknown) => Promise<unknown>) => mutate(_prisma),
}));
vi.mock("@/lib/work-item-sequence", async () => (await import("../helpers/work-item-sequence-mock")).workItemSequenceMock());

import { createRoadmapItemsFromSolutions } from "@/lib/roadmap/create-from-solution";

const context = { workspaceId: "ws-1", source: "UI", captureSource: "UI" as const, userId: "user-1", today: "2026-10-05" };
const fresh = (): FakeState => ({ solutions: [solutionRow("s1"), solutionRow("s2")], squads: [{ id: "squad-a", workspaceId: "ws-1" }, { id: "squad-b", workspaceId: "ws-1" }], items: [] });
const inherited = [{ fieldId: "f-partner", fieldName: "Partner", from: { objectType: "OPPORTUNITY", objectId: "opp-s1", fieldId: "f-customer", fieldName: "Customer" }, value: "acme" }];

beforeEach(() => {
  vi.clearAllMocks();
  m.apply.mockResolvedValue({ applied: inherited, skipped: [] });
});

describe("createRoadmapItemsFromSolutions inheritance", () => {
  it("runs the hook once per created item, inside the create transaction, with the solution and its opportunity", async () => {
    const state = fresh();
    const prisma = createFakePrisma(state);
    const result = await createRoadmapItemsFromSolutions(prisma, context, [{ solutionId: "s1" }, { solutionId: "s2" }]);

    expect(m.apply).toHaveBeenCalledTimes(2);
    expect(m.apply).toHaveBeenCalledWith(prisma, {
      workspaceId: "ws-1", targetObjectType: "ROADMAP_ITEM", targetId: state.items[0].id,
      links: { opportunityId: "opp-s1", solutionId: "s1" },
    });
    expect(result.created[0]).toMatchObject({ solutionId: "s1", inheritedFields: inherited });
  });

  it("honours a null opportunity override (nothing to inherit from there)", async () => {
    const state = fresh();
    await createRoadmapItemsFromSolutions(createFakePrisma(state), context, [{ solutionId: "s1", opportunityId: null }]);
    expect(m.apply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ links: { opportunityId: null, solutionId: "s1" } }));
  });

  it("does not run the hook for a solution that already has an active item", async () => {
    const state = fresh();
    const prisma = createFakePrisma(state);
    await createRoadmapItemsFromSolutions(prisma, context, [{ solutionId: "s1" }]);
    m.apply.mockClear();
    const second = await createRoadmapItemsFromSolutions(prisma, context, [{ solutionId: "s1" }]);
    expect(m.apply).not.toHaveBeenCalled();
    expect(second.created).toEqual([]);
  });
});
