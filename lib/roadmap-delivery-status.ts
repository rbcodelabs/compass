import type { TaskStatus } from "@/lib/types";

export type RoadmapDeliveryStatus =
  | "NOT_STARTED"
  | "IN_DEVELOPMENT"
  | "IN_REVIEW"
  | "BLOCKED"
  | "COMPLETE";

export const ROADMAP_DELIVERY_STATUS_LABELS: Record<RoadmapDeliveryStatus, string> = {
  NOT_STARTED: "Not Started",
  IN_DEVELOPMENT: "In Development",
  IN_REVIEW: "In Review",
  BLOCKED: "Blocked",
  COMPLETE: "Complete",
};

/** Derives roadmap delivery state from directly linked tasks; cancelled work is ignored. */
export function deriveRoadmapDeliveryStatus(
  taskStatuses: readonly TaskStatus[],
): RoadmapDeliveryStatus {
  const activeStatuses = taskStatuses.filter((status) => status !== "CANCELLED");

  if (activeStatuses.includes("BLOCKED")) return "BLOCKED";
  if (activeStatuses.includes("IN_REVIEW")) return "IN_REVIEW";
  if (activeStatuses.includes("IN_PROGRESS")) return "IN_DEVELOPMENT";
  if (activeStatuses.length > 0 && activeStatuses.every((status) => status === "DONE")) {
    return "COMPLETE";
  }
  return "NOT_STARTED";
}
