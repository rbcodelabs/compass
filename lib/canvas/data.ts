/**
 * Server-side data loader for the Canvas viewer (Phase 1: Objective/KeyResult
 * tier only).
 *
 * Flat-query-plus-in-memory-join, mirroring okrs/[cycleId]/page.tsx's
 * objective.findMany -> keyResult.findMany({objectiveId:{in}}) -> grouped
 * join style rather than a deep Prisma `include` (same rationale: keeps each
 * query cheap and predictable at "hundreds of Objectives" scale). Kept here
 * in lib/ — not inlined in the page — so it's testable via the
 * `vi.mock("@/lib/db")` pattern used in __tests__/actions/okrs.test.ts,
 * independent of Next.js request context.
 */
import type { PrismaClient } from "@prisma/client";
import type { ObjectiveStatus, SquadData } from "@/lib/types";
import type { CanvasPosition } from "./layout";

export interface CanvasKeyResult {
  id: string;
  title: string;
  current: number;
  target: number;
  unit: string | null;
}

export interface CanvasObjective {
  id: string;
  title: string;
  status: ObjectiveStatus;
  squad: SquadData | null;
  keyResults: CanvasKeyResult[];
  /** Saved canvas position, or null if this Objective has never been pinned. */
  position: CanvasPosition | null;
}

export interface CanvasOverview {
  objectives: CanvasObjective[];
}

/**
 * Loads every Objective + Key Result across every OKR cycle in the
 * workspace (Phase 1 deliberately does not scope to the active cycle — see
 * the Canvas Phase 1 plan's Step 5 for why), plus any saved
 * CanvasNodePosition rows so pinned Objectives render at their saved spot.
 *
 * Phase 1 never writes CanvasNodePosition rows (no drag-to-pin UI yet), so
 * `position` is always null today — but Key Result positions are queried
 * alongside Objective positions now (single round-trip covering both entity
 * types the table supports) so Phase 2's drag-to-pin doesn't need a query
 * shape change, even though Key Results aren't independently positioned
 * nodes until then.
 */
export async function getCanvasOverview(
  prisma: PrismaClient,
  workspaceId: string
): Promise<CanvasOverview> {
  const [squadsRaw, objectivesRaw] = await Promise.all([
    prisma.squad.findMany({ where: { workspaceId } }),
    prisma.objective.findMany({
      where: { cycle: { workspaceId } },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    }),
  ]);

  const squadById = new Map<string, SquadData>(
    squadsRaw.map((s) => [s.id, { id: s.id, name: s.name, color: s.color }])
  );

  const objectiveIds = objectivesRaw.map((o) => o.id);

  const keyResultsRaw =
    objectiveIds.length > 0
      ? await prisma.keyResult.findMany({
          where: { objectiveId: { in: objectiveIds } },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        })
      : [];

  const keyResultsByObjectiveId = keyResultsRaw.reduce<
    Record<string, typeof keyResultsRaw>
  >((acc, kr) => {
    (acc[kr.objectiveId] ??= []).push(kr);
    return acc;
  }, {});

  const entityIds = [...objectiveIds, ...keyResultsRaw.map((kr) => kr.id)];

  const positionsRaw =
    entityIds.length > 0
      ? await prisma.canvasNodePosition.findMany({
          where: {
            workspaceId,
            entityType: { in: ["OBJECTIVE", "KEY_RESULT"] },
            entityId: { in: entityIds },
          },
        })
      : [];

  const positionByEntity = new Map<string, CanvasPosition>(
    positionsRaw.map((p) => [
      `${p.entityType}:${p.entityId}`,
      { x: p.x, y: p.y, pinned: p.pinned },
    ])
  );

  const objectives: CanvasObjective[] = objectivesRaw.map((obj) => ({
    id: obj.id,
    title: obj.title,
    status: obj.status as ObjectiveStatus,
    squad: obj.squadId ? (squadById.get(obj.squadId) ?? null) : null,
    keyResults: (keyResultsByObjectiveId[obj.id] ?? []).map((kr) => ({
      id: kr.id,
      title: kr.title,
      current: kr.current,
      target: kr.target,
      unit: kr.unit,
    })),
    position: positionByEntity.get(`OBJECTIVE:${obj.id}`) ?? null,
  }));

  return { objectives };
}
