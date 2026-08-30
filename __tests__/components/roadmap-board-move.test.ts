// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";

// RoadmapBoard imports its server-action module, which now includes an
// authenticated relation mutation. Keep this pure state-helper test out of
// next-auth's server-only module graph.
vi.mock("@/auth", () => ({ auth: vi.fn() }));
import { moveCardToHorizon, buildColumnMap } from "@/components/roadmap/roadmap-board";
import type { RoadmapCardData } from "@/components/roadmap/roadmap-card";

function card(id: string, horizon: RoadmapCardData["horizon"], sortOrder = 0): RoadmapCardData {
  return {
    id,
    title: `Item ${id}`,
    description: null,
    horizon,
    sortOrder,
    isPrivate: false,
    solutionId: null,
    keyResultId: null,
    opportunityId: null,
    experimentId: null,
    feedbackId: null,
    startDate: null,
    endDate: null,
    solution: null,
    keyResult: null,
    opportunity: null,
    experiment: null,
    feedback: null,
    squad: null,
    launchChecklist: null,
    deliveryStatus: "NOT_STARTED",
  };
}

describe("moveCardToHorizon", () => {
  it("moves a card from its current column into the target horizon column", () => {
    const columns = buildColumnMap([card("a", "NOW"), card("b", "NEXT")]);

    const next = moveCardToHorizon(columns, "a", "LAUNCHING");

    expect(next.NOW.map((i) => i.id)).toEqual([]);
    expect(next.LAUNCHING.map((i) => i.id)).toEqual(["a"]);
    expect(next.LAUNCHING[0].horizon).toBe("LAUNCHING");
    // Untouched columns/items are unaffected.
    expect(next.NEXT.map((i) => i.id)).toEqual(["b"]);
  });

  it("finds the card regardless of which column it currently lives in", () => {
    const columns = buildColumnMap([card("a", "LATER")]);

    const next = moveCardToHorizon(columns, "a", "LAUNCHING");

    expect(next.LATER).toEqual([]);
    expect(next.LAUNCHING.map((i) => i.id)).toEqual(["a"]);
  });

  it("is a no-op (same reference) when the card is already in the target horizon", () => {
    const columns = buildColumnMap([card("a", "LAUNCHING")]);

    const next = moveCardToHorizon(columns, "a", "LAUNCHING");

    expect(next).toBe(columns);
  });

  it("is a no-op when the card id isn't found in any column", () => {
    const columns = buildColumnMap([card("a", "NOW")]);

    const next = moveCardToHorizon(columns, "does-not-exist", "LAUNCHING");

    expect(next).toBe(columns);
  });

  it("appends the moved card after any cards already in the target column", () => {
    const columns = buildColumnMap([card("existing", "LAUNCHING", 0), card("a", "NOW", 0)]);

    const next = moveCardToHorizon(columns, "a", "LAUNCHING");

    expect(next.LAUNCHING.map((i) => i.id)).toEqual(["existing", "a"]);
  });
});
