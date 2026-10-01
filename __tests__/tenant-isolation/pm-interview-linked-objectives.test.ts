import { describe, expect, it, vi } from "vitest";
import { targetSnapshot } from "@/lib/pm-interview-service";
import type { AppPrismaClient } from "@/lib/db";

vi.mock("@/lib/db", () => ({ default: () => ({}) }));

const WS = "00000000-0000-4000-8000-0000000000a1";
const OPP = "00000000-0000-4000-8000-0000000000b1";
const OBJ = "00000000-0000-4000-8000-0000000000c1";
const FOREIGN_OBJ = "00000000-0000-4000-8000-0000000000c2";

function prismaWith(links: { id: string; opportunityId: string; objectiveId: string; createdAt: Date }[]) {
  const objectiveFindMany = vi.fn(async ({ where }: { where: { id: { in: string[] }; workspaceId: string } }) =>
    where.workspaceId === WS && where.id.in.includes(OBJ) ? [{ id: OBJ, title: "Grow revenue" }] : [],
  );
  const linkFindMany = vi.fn(async () => links);
  const prisma = {
    opportunity: {
      findFirst: vi.fn(async () => ({ id: OPP, title: "Churn", description: null, customerSegment: null, status: "EXPLORING", linkedKeyResult: null, evidence: [], feedback: [] })),
      findMany: vi.fn(async () => [{ id: OPP }]),
    },
    opportunityObjectiveLink: { findMany: linkFindMany },
    objective: { findMany: objectiveFindMany },
  };
  return { prisma: prisma as unknown as AppPrismaClient, linkFindMany, objectiveFindMany };
}

describe("PM interview context carries the linked objectives (additive)", () => {
  it("adds linkedObjectives from the workspace-filtered links, and hides an objective that is not in the workspace", async () => {
    const { prisma, linkFindMany, objectiveFindMany } = prismaWith([
      { id: "l1", opportunityId: OPP, objectiveId: OBJ, createdAt: new Date(1) },
      { id: "l2", opportunityId: OPP, objectiveId: FOREIGN_OBJ, createdAt: new Date(2) },
    ]);
    const snapshot = await targetSnapshot(prisma, WS, "OPPORTUNITY", OPP);
    expect(snapshot.linkedObjectives).toEqual([{ id: OBJ, title: "Grow revenue" }]);
    // The legacy outcome is a separate field and is never inferred from the links.
    expect(snapshot.outcome).toBeNull();
    expect(linkFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: WS, opportunityId: { in: [OPP] } } }));
    expect(objectiveFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: [OBJ, FOREIGN_OBJ] }, workspaceId: WS } }));
  });

  it("omits the field entirely when there are no links, so existing contexts are unchanged", async () => {
    const { prisma } = prismaWith([]);
    const snapshot = await targetSnapshot(prisma, WS, "OPPORTUNITY", OPP);
    expect("linkedObjectives" in snapshot).toBe(false);
  });
});
