import { describe, expect, it } from "vitest";
import { deriveRoadmapDeliveryStatus } from "@/lib/roadmap-delivery-status";

describe("deriveRoadmapDeliveryStatus", () => {
  it.each([
    [[], "NOT_STARTED"],
    [["CANCELLED"], "NOT_STARTED"],
    [["DONE"], "COMPLETE"],
    [["DONE", "DONE", "CANCELLED"], "COMPLETE"],
    [["IN_PROGRESS"], "IN_DEVELOPMENT"],
    [["IN_REVIEW"], "IN_REVIEW"],
    [["BLOCKED"], "BLOCKED"],
    [["TODO", "DONE"], "NOT_STARTED"],
    [["BACKLOG", "DONE"], "NOT_STARTED"],
    [["IN_PROGRESS", "IN_REVIEW"], "IN_REVIEW"],
    [["DONE", "IN_REVIEW", "BLOCKED"], "BLOCKED"],
  ] as const)("derives %j as %s", (taskStatuses, expected) => {
    expect(deriveRoadmapDeliveryStatus(taskStatuses)).toBe(expected);
  });
});
