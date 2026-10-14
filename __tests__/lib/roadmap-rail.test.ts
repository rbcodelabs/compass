import { describe, expect, it } from "vitest";
import {
  groupByOpportunity,
  matchesBuildPreset,
  matchesQuery,
  matchesRailFilter,
  searchCatalog,
  solutionsToSchedule,
  type CatalogSolution,
} from "@/lib/roadmap/rail";

const sol = (id: string, opportunityId: string, over: Partial<CatalogSolution> = {}): CatalogSolution => ({
  id,
  title: `Solution ${id}`,
  status: "VALIDATED",
  score: null,
  opportunityId,
  opportunityTitle: `Opportunity ${opportunityId}`,
  squadId: null,
  ...over,
});

describe("rail filters", () => {
  it("All keeps everything, Validated only validated, Scored 70+ only scores at the threshold", () => {
    expect(matchesRailFilter({ status: "IN_DELIVERY", score: 10 }, "all")).toBe(true);
    expect(matchesRailFilter({ status: "IN_DELIVERY" }, "validated")).toBe(false);
    expect(matchesRailFilter({ status: "VALIDATED" }, "validated")).toBe(true);
    expect(matchesRailFilter({ score: 69.9 }, "top")).toBe(false);
    expect(matchesRailFilter({ score: 70 }, "top")).toBe(true);
    expect(matchesRailFilter({ score: null }, "top")).toBe(false);
  });

  it("search matches every word across title and opportunity, case-insensitively", () => {
    expect(matchesQuery("", "anything")).toBe(true);
    expect(matchesQuery("  PORTAL road", "Public portal", "Customers can't see our roadmap")).toBe(true);
    expect(matchesQuery("portal digest", "Public portal", "Customers")).toBe(false);
  });
});

describe("build presets", () => {
  it("mirror the server predicates", () => {
    expect(matchesBuildPreset("validated", { status: "VALIDATED" })).toBe(true);
    expect(matchesBuildPreset("validated", { status: "IN_DELIVERY" })).toBe(false);
    expect(matchesBuildPreset("building", { status: "IN_DELIVERY" })).toBe(true);
    expect(matchesBuildPreset("top-scored", { status: "VALIDATED", score: 82 })).toBe(true);
    expect(matchesBuildPreset("top-scored", { status: "IDEA", score: 95 })).toBe(false);
    expect(matchesBuildPreset("top-scored", { status: "VALIDATED", score: 40 })).toBe(false);
  });
});

describe("groupByOpportunity", () => {
  it("keeps first-seen opportunity order and sorts each group by score", () => {
    const groups = groupByOpportunity([sol("a", "o1", { score: 50 }), sol("b", "o2"), sol("c", "o1", { score: 90 })]);
    expect(groups.map((group) => group.opportunityId)).toEqual(["o1", "o2"]);
    expect(groups[0].items.map((item) => item.id)).toEqual(["c", "a"]);
  });
});

describe("palette search", () => {
  const catalog = {
    solutions: [sol("a", "o1", { score: 60 }), sol("b", "o1", { score: 90 }), sol("c", "o2", { score: 70 })],
    opportunities: [
      { id: "o1", title: "Opportunity o1", squadId: null },
      { id: "o2", title: "Opportunity o2", squadId: null },
    ],
  };

  it("lists unscheduled solutions first by score, then scheduled ones, then opportunities", () => {
    const rows = searchCatalog(catalog, new Set(["b"]), "");
    expect(rows.map((row) => (row.type === "solution" ? row.solution.id : `opp:${row.opportunity.id}`))).toEqual(["c", "a", "b", "opp:o1", "opp:o2"]);
    const scheduled = rows.find((row) => row.type === "solution" && row.solution.id === "b");
    expect(scheduled).toMatchObject({ scheduled: true });
  });

  it("filters both groups by the query", () => {
    const rows = searchCatalog(catalog, new Set(), "o2");
    expect(rows.map((row) => row.type)).toEqual(["solution", "opportunity"]);
  });

  it("an opportunity row carries its unscheduled solutions", () => {
    const [opportunityRow] = searchCatalog(catalog, new Set(["a"]), "").filter((row) => row.type === "opportunity");
    expect(opportunityRow.type === "opportunity" && opportunityRow.unscheduled.map((s) => s.id)).toEqual(["b"]);
  });
});

describe("solutionsToSchedule", () => {
  const catalog = { solutions: [sol("a", "o1"), sol("b", "o1"), sol("c", "o2")] };
  const rows = searchCatalog({ ...catalog, opportunities: [{ id: "o1", title: "Opportunity o1", squadId: null }] }, new Set(["a"]), "");

  it("Enter on a solution schedules just that solution; a scheduled one is inert", () => {
    const b = rows.find((row) => row.type === "solution" && row.solution.id === "b")!;
    const a = rows.find((row) => row.type === "solution" && row.solution.id === "a")!;
    expect(solutionsToSchedule(b, catalog, new Set(["a"]), false).map((s) => s.id)).toEqual(["b"]);
    expect(solutionsToSchedule(a, catalog, new Set(["a"]), false)).toEqual([]);
  });

  it("Shift+Enter, or choosing the opportunity, schedules every unscheduled solution under it", () => {
    const b = rows.find((row) => row.type === "solution" && row.solution.id === "b")!;
    const opportunity = rows.find((row) => row.type === "opportunity")!;
    expect(solutionsToSchedule(b, catalog, new Set(["a"]), true).map((s) => s.id)).toEqual(["b"]);
    expect(solutionsToSchedule(opportunity, catalog, new Set(), false).map((s) => s.id)).toEqual(["a", "b"]);
  });
});
