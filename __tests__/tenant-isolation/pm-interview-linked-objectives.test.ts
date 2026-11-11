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
  // entity_links: the Opportunity <-> Objective rows are served for that link type; the Key Result pointer read finds none.
  const linkFindMany = vi.fn(async ({ where }: { where: { linkType: string } }) =>
    where.linkType === "OPPORTUNITY_TARGETS_OBJECTIVE"
      ? links.map((l) => ({ id: l.id, linkType: where.linkType, fromType: "OPPORTUNITY", fromId: l.opportunityId, toType: "OBJECTIVE", toId: l.objectiveId, origin: "DIRECT", source: "UI", createdById: null, createdAt: l.createdAt }))
      : [],
  );
  const prisma = {
    opportunity: {
      findFirst: vi.fn(async () => ({ id: OPP, title: "Churn", description: null, customerSegment: null, status: "EXPLORING", evidence: [], feedback: [] })),
      findMany: vi.fn(async () => [{ id: OPP }]),
    },
    entityLink: { findMany: linkFindMany },
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
    // The outcome (the Key Result pointer) is a separate field and is never inferred from the objective links.
    expect(snapshot.outcome).toBeNull();
    expect(linkFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS, linkType: "OPPORTUNITY_TARGETS_OBJECTIVE", fromId: { in: [OPP] } }) }));
    expect(objectiveFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: [OBJ, FOREIGN_OBJ] }, workspaceId: WS } }));
  });

  it("omits the field entirely when there are no links, so existing contexts are unchanged", async () => {
    const { prisma } = prismaWith([]);
    const snapshot = await targetSnapshot(prisma, WS, "OPPORTUNITY", OPP);
    expect("linkedObjectives" in snapshot).toBe(false);
  });
});
