/**
 * The roadmap card projection shared by the roadmap page and the server actions
 * that create items, so an optimistically-added bar is built from exactly the
 * same fields the page would render after a reload.
 */
import type { Prisma } from "@prisma/client";
import type { Horizon, TaskStatus } from "@/lib/types";
import type { RoadmapCardData } from "@/components/roadmap/roadmap-card";
import { deriveRoadmapDeliveryStatus } from "@/lib/roadmap-delivery-status";

export const ROADMAP_CARD_INCLUDE = {
  solution: { select: { id: true, title: true } },
  keyResult: {
    select: {
      id: true,
      title: true,
      current: true,
      target: true,
      unit: true,
      objective: { select: { cycleId: true } },
    },
  },
  opportunity: { select: { id: true, title: true } },
  experiment: { select: { id: true, title: true } },
  feedback: { select: { id: true, title: true, type: true } },
  squad: { select: { id: true, name: true, color: true } },
  launchChecklist: { select: { tier: true, items: { select: { status: true } } } },
} satisfies Prisma.RoadmapItemInclude;

export type RoadmapItemWithCardRelations = Prisma.RoadmapItemGetPayload<{ include: typeof ROADMAP_CARD_INCLUDE }>;

export function toRoadmapCardData(item: RoadmapItemWithCardRelations, taskStatuses: readonly TaskStatus[] = []): RoadmapCardData {
  return {
    id: item.id,
    title: item.title,
    description: item.description ?? null,
    horizon: item.horizon as Horizon,
    sortOrder: item.sortOrder,
    isPrivate: item.isPrivate,
    solutionId: item.solutionId ?? null,
    keyResultId: item.keyResultId ?? null,
    opportunityId: item.opportunityId ?? null,
    experimentId: item.experimentId ?? null,
    feedbackId: item.feedbackId ?? null,
    startDate: item.startDate ? item.startDate.toISOString() : null,
    endDate: item.endDate ? item.endDate.toISOString() : null,
    updatedAt: item.updatedAt.toISOString(),
    autoCreated: item.autoCreated === true,
    solution: item.solution ?? null,
    keyResult: item.keyResult
      ? {
          id: item.keyResult.id,
          title: item.keyResult.title,
          current: item.keyResult.current,
          target: item.keyResult.target,
          unit: item.keyResult.unit,
          cycleId: item.keyResult.objective?.cycleId ?? null,
        }
      : null,
    opportunity: item.opportunity ?? null,
    experiment: item.experiment ?? null,
    feedback: item.feedback ?? null,
    squad: item.squad ?? null,
    launchChecklist: item.launchChecklist
      ? {
          tier: item.launchChecklist.tier,
          done: item.launchChecklist.items.filter((i) => i.status === "DONE").length,
          total: item.launchChecklist.items.length,
        }
      : null,
    deliveryStatus: deriveRoadmapDeliveryStatus(taskStatuses),
  };
}
