import { describe, it, expect } from "vitest";
import {
  getTierForZoom,
  isNodeTypeVisibleAtTier,
  tierLabels,
  type CanvasTier,
} from "@/lib/canvas/tiers";
import type { CanvasNodeType } from "@/lib/canvas/layout";
import { CLASSIC_THINKING_MODEL, resolveThinkingModel } from "@/lib/thinking-model/resolve";

describe("getTierForZoom", () => {
  it("returns T0 well below the T0 threshold", () => {
    expect(getTierForZoom(0.1)).toBe("T0");
  });

  it("returns T0 just below the T0 threshold (0.4)", () => {
    expect(getTierForZoom(0.39)).toBe("T0");
  });

  it("returns T1 exactly at the T0 threshold (0.4)", () => {
    expect(getTierForZoom(0.4)).toBe("T1");
  });

  it("returns T1 between the T0 and T1 thresholds", () => {
    expect(getTierForZoom(0.5)).toBe("T1");
  });

  it("returns T1 just below the T1 threshold (0.75)", () => {
    expect(getTierForZoom(0.74)).toBe("T1");
  });

  it("returns T2 exactly at the T1 threshold (0.75)", () => {
    expect(getTierForZoom(0.75)).toBe("T2");
  });

  it("returns T2 well above the T1 threshold", () => {
    expect(getTierForZoom(2)).toBe("T2");
  });

  it("returns T0 at zoom 0", () => {
    expect(getTierForZoom(0)).toBe("T0");
  });
});

describe("isNodeTypeVisibleAtTier", () => {
  const allTypes: CanvasNodeType[] = [
    "objective",
    "keyResult",
    "opportunity",
    "solution",
    "assumption",
    "experiment",
    "roadmapItem",
  ];

  const expectedVisibility: Record<CanvasTier, Record<CanvasNodeType, boolean>> = {
    T0: {
      objective: true,
      keyResult: false,
      opportunity: false,
      solution: false,
      assumption: false,
      experiment: false,
      roadmapItem: false,
    },
    T1: {
      objective: true,
      keyResult: true,
      opportunity: false,
      solution: false,
      assumption: false,
      experiment: false,
      roadmapItem: false,
    },
    T2: {
      objective: true,
      keyResult: true,
      opportunity: true,
      solution: true,
      assumption: true,
      experiment: true,
      roadmapItem: true,
    },
  };

  for (const tier of Object.keys(expectedVisibility) as CanvasTier[]) {
    for (const type of allTypes) {
      it(`${type} is ${expectedVisibility[tier][type] ? "visible" : "hidden"} at ${tier}`, () => {
        expect(isNodeTypeVisibleAtTier(type, tier)).toBe(expectedVisibility[tier][type]);
      });
    }
  }
});

describe("tierLabels", () => {
  it("has a human-readable label for every tier (CLASSIC: today's text)", () => {
    const labels = tierLabels(CLASSIC_THINKING_MODEL.labels);
    expect(labels.T0).toBe("Portfolio");
    expect(labels.T1).toBe("Cycle");
    expect(labels.T2).toBe("Detail");
  });

  it("the middle tier takes the workspace's Cycle name", () => {
    const sprint = resolveThinkingModel({ thinkingModelLabels: JSON.stringify({ cycle: { singular: "Sprint" } }) });
    expect(tierLabels(sprint.labels).T1).toBe("Sprint");
  });
});
