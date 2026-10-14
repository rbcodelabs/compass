import { describe, expect, it } from "vitest";
import {
  buildSolutionBacklogColumns,
  legacySwimlaneRedirectPath,
  parseSolutionBacklogColumnId,
  planSolutionDrop,
  solutionBacklogColumnId,
  solutionBacklogKey,
} from "@/lib/solution-backlog";
import type { SolutionStatus } from "@/lib/types";

const card = (id: string, status: SolutionStatus, sortOrder: number, score?: number) => ({
  id,
  status,
  sortOrder,
  score: score === undefined ? null : { normalizedScore: score },
  opportunity: { id: `opp-${id}`, title: `Opp ${id}` },
});

describe("buildSolutionBacklogColumns", () => {
  const cards = [
    card("a", "IDEA", 2, 10),
    card("b", "IDEA", 0, 90),
    card("c", "SHIPPED", 0),
    card("d", "IDEA", 1),
  ];

  it("returns every status column, empty ones included, in one flat pass across opportunities", () => {
    const columns = buildSolutionBacklogColumns(cards, false);
    expect(Object.keys(columns)).toEqual(["IDEA", "VALIDATED", "IN_DELIVERY", "SHIPPED", "KILLED"]);
    expect(columns.VALIDATED).toEqual([]);
    expect(columns.SHIPPED.map((c) => c.id)).toEqual(["c"]);
  });

  it("orders manually by sortOrder", () => {
    expect(buildSolutionBacklogColumns(cards, false).IDEA.map((c) => c.id)).toEqual(["b", "d", "a"]);
  });

  it("orders by score, highest first with unscored last, when sorting by score", () => {
    expect(buildSolutionBacklogColumns(cards, true).IDEA.map((c) => c.id)).toEqual(["b", "a", "d"]);
  });
});

describe("solution backlog column ids", () => {
  it("round-trips a status and rejects card ids and unknown statuses", () => {
    expect(parseSolutionBacklogColumnId(solutionBacklogColumnId("IN_DELIVERY"))).toBe("IN_DELIVERY");
    expect(parseSolutionBacklogColumnId("0b7e1c9e-uuid")).toBeNull();
    expect(parseSolutionBacklogColumnId("column-NOPE")).toBeNull();
  });
});

describe("planSolutionDrop", () => {
  it("persists only a cross-column move", () => {
    expect(planSolutionDrop("IDEA", "VALIDATED")).toEqual({ kind: "move", status: "VALIDATED" });
    expect(planSolutionDrop("IDEA", "IDEA")).toEqual({ kind: "none" });
    expect(planSolutionDrop(null, "IDEA")).toEqual({ kind: "none" });
    expect(planSolutionDrop("IDEA", null)).toEqual({ kind: "none" });
  });
});

describe("solutionBacklogKey", () => {
  it("changes with the id set and ignores status moves", () => {
    const a = [card("a", "IDEA", 0), card("b", "IDEA", 1)];
    const moved = [card("a", "SHIPPED", 0), card("b", "IDEA", 1)];
    expect(solutionBacklogKey(moved)).toBe(solutionBacklogKey(a));
    expect(solutionBacklogKey([a[0]])).not.toBe(solutionBacklogKey(a));
  });
});

describe("legacySwimlaneRedirectPath", () => {
  it("lands on the Solutions page, keeping squad and field filters", () => {
    expect(legacySwimlaneRedirectPath("org", "ws", {})).toBe("/org/ws/solutions");
    expect(legacySwimlaneRedirectPath("org", "ws", { squad: "s1", field: "f1", fieldValue: "x y" })).toBe(
      "/org/ws/solutions?squad=s1&field=f1&fieldValue=x+y"
    );
  });
});
