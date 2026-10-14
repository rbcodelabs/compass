// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { moveCardToHorizon, applyRoadmapItemPatch, buildColumnMap } from "@/components/roadmap/roadmap-board";
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
    updatedAt: "2026-09-05T00:00:00.000Z",
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

describe("applyRoadmapItemPatch", () => {
  const columns = () => buildColumnMap([card("a", "NOW"), card("b", "NEXT")]);

  it("merges edited card fields without moving the card", () => {
    const next = applyRoadmapItemPatch(columns(), "a", { roadmapItem: { title: "Renamed", isPrivate: true, squad: { id: "s", name: "Growth", color: "#fff" } } });
    expect(next.NOW[0]).toMatchObject({ id: "a", title: "Renamed", isPrivate: true, squad: { name: "Growth" } });
    expect(next.NEXT).toHaveLength(1);
  });

  it("moves the card when the horizon changed, carrying the merged fields", () => {
    const next = applyRoadmapItemPatch(columns(), "a", { horizon: "LATER", roadmapItem: { title: "Renamed", horizon: "LATER" } });
    expect(next.NOW).toHaveLength(0);
    expect(next.LATER[0]).toMatchObject({ id: "a", title: "Renamed", horizon: "LATER" });
  });

  it("drops an archived card", () => {
    const next = applyRoadmapItemPatch(columns(), "b", { archived: true });
    expect(next.NEXT).toHaveLength(0);
    expect(next.NOW).toHaveLength(1);
  });

  it("is a no-op for a card the board does not hold", () => {
    const before = columns();
    expect(applyRoadmapItemPatch(before, "missing", { roadmapItem: { title: "x" } })).toBe(before);
  });
});
