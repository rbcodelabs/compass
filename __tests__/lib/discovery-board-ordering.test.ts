import { describe, it, expect } from "vitest";
import {
  orderCards,
  planDragEnd,
  sortByScoreDesc,
  sortBySortOrder,
} from "@/lib/discovery-board-ordering";

function card(id: string, sortOrder: number, normalizedScore?: number) {
  return {
    id,
    sortOrder,
    score: typeof normalizedScore === "number" ? { normalizedScore } : null,
  };
}

describe("sortBySortOrder", () => {
  it("orders by the persisted sortOrder ascending", () => {
    const items = [card("c", 2), card("a", 0), card("b", 1)];
    expect(sortBySortOrder(items).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the input array", () => {
    const items = [card("c", 2), card("a", 0)];
    sortBySortOrder(items);
    expect(items.map((i) => i.id)).toEqual(["c", "a"]);
  });
});

describe("sortByScoreDesc", () => {
  it("ranks scored opportunities highest score first", () => {
    const items = [card("low", 0, 11.97), card("high", 1, 88.4), card("mid", 2, 50)];
    expect(sortByScoreDesc(items).map((i) => i.id)).toEqual(["high", "mid", "low"]);
  });

  it("sorts unscored opportunities last, regardless of their sortOrder", () => {
    const items = [card("unscored-first", 0), card("scored-last", 9, 1.2)];
    expect(sortByScoreDesc(items).map((i) => i.id)).toEqual(["scored-last", "unscored-first"]);
  });

  it("treats a zero score as scored, not as unscored", () => {
    const items = [card("unscored", 0), card("zero", 1, 0)];
    expect(sortByScoreDesc(items).map((i) => i.id)).toEqual(["zero", "unscored"]);
  });

  it("breaks ties — and orders the unscored tail — by sortOrder", () => {
    const items = [
      card("tie-b", 3, 50),
      card("tie-a", 1, 50),
      card("un-b", 7),
      card("un-a", 4),
    ];
    expect(sortByScoreDesc(items).map((i) => i.id)).toEqual([
      "tie-a",
      "tie-b",
      "un-a",
      "un-b",
    ]);
  });

  it("does not mutate the input array", () => {
    const items = [card("low", 0, 10), card("high", 1, 90)];
    sortByScoreDesc(items);
    expect(items.map((i) => i.id)).toEqual(["low", "high"]);
  });
});

describe("orderCards", () => {
  const items = [card("low", 0, 10), card("high", 1, 90), card("none", 2)];

  it("uses manual order when score sort is off", () => {
    expect(orderCards(items, false).map((i) => i.id)).toEqual(["low", "high", "none"]);
  });

  it("uses score order when score sort is on", () => {
    expect(orderCards(items, true).map((i) => i.id)).toEqual(["high", "low", "none"]);
  });
});

describe("planDragEnd", () => {
  const base = {
    activeId: "a",
    overId: "b",
    currentStatus: "EXPLORING" as const,
    dragSourceStatus: "EXPLORING" as const,
    oldIndex: 0,
    newIndex: 2,
    scoreSortActive: false,
  };

  it("persists a same-column reorder in manual mode", () => {
    expect(planDragEnd(base)).toEqual({ kind: "reorder", oldIndex: 0, newIndex: 2 });
  });

  it("persists a cross-column move in manual mode", () => {
    expect(
      planDragEnd({ ...base, dragSourceStatus: "VALIDATING", currentStatus: "ACTIVE" })
    ).toEqual({ kind: "move", status: "ACTIVE" });
  });

  // ─── The data-corruption guard ────────────────────────────────────────────
  // Under score sort the on-screen order comes from normalizedScore, so a drop
  // index is not a valid sortOrder. Writing it would overwrite the user's
  // manual board order with score ranking, permanently.
  it("persists NOTHING for a same-column reorder while score sort is active", () => {
    expect(planDragEnd({ ...base, scoreSortActive: true })).toEqual({ kind: "none" });
  });

  it("persists NOTHING for a cross-column move while score sort is active", () => {
    expect(
      planDragEnd({
        ...base,
        dragSourceStatus: "VALIDATING",
        currentStatus: "ACTIVE",
        scoreSortActive: true,
      })
    ).toEqual({ kind: "none" });
  });

  it("persists nothing when dropped outside any droppable", () => {
    expect(planDragEnd({ ...base, overId: null })).toEqual({ kind: "none" });
  });

  it("persists nothing when the dragged card has no resolvable column", () => {
    expect(planDragEnd({ ...base, currentStatus: null })).toEqual({ kind: "none" });
  });

  it("persists nothing when dropped on the column itself within the same column", () => {
    expect(planDragEnd({ ...base, overId: "column-EXPLORING" })).toEqual({ kind: "none" });
  });

  it("persists nothing when dropped back onto itself", () => {
    expect(planDragEnd({ ...base, overId: "a" })).toEqual({ kind: "none" });
  });

  it("persists nothing when the index does not actually change", () => {
    expect(planDragEnd({ ...base, oldIndex: 1, newIndex: 1 })).toEqual({ kind: "none" });
  });

  it("persists nothing when an index cannot be resolved", () => {
    expect(planDragEnd({ ...base, newIndex: -1 })).toEqual({ kind: "none" });
  });
});
