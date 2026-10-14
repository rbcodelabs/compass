import { describe, expect, it } from "vitest";
import {
  buildSolutionGroups,
  groupableSolutionFields,
  orderSolutionsForTable,
  resolveSolutionGroupBy,
  solutionFieldGroupByValue,
  solutionGroupByFieldId,
  type SolutionGroupCard,
} from "@/lib/solution-backlog-grouping";
import type { CustomFieldDefinitionData } from "@/lib/types";

const def = (over: Partial<CustomFieldDefinitionData>): CustomFieldDefinitionData => ({
  id: "f1",
  name: "Effort",
  fieldType: "SELECT",
  objectType: "SOLUTION",
  options: [
    { value: "s", label: "Small" },
    { value: "l", label: "Large", color: "#f00" },
  ],
  sharedOptionSetId: null,
  sharedOptionSetName: null,
  required: false,
  order: 0,
  ...over,
});

const squadA = { id: "sq-a", name: "Alpha", color: "#111" };
const squadB = { id: "sq-b", name: "Beta", color: "#222" };

const card = (
  id: string,
  over: Partial<SolutionGroupCard> & { opp?: string; squad?: typeof squadA | null } = {}
): SolutionGroupCard => ({
  id,
  status: over.status ?? "IDEA",
  sortOrder: over.sortOrder ?? 0,
  score: over.score ?? null,
  fieldValue: over.fieldValue,
  opportunity: { id: `o-${over.opp ?? id}`, title: `Opp ${over.opp ?? id}`, squad: over.squad ?? null },
});

describe("groupableSolutionFields", () => {
  it("keeps only Solution single-selects with options", () => {
    const fields = groupableSolutionFields([
      def({ id: "ok" }),
      def({ id: "opp", objectType: "OPPORTUNITY" }),
      def({ id: "multi", fieldType: "MULTI_SELECT" }),
      def({ id: "text", fieldType: "TEXT", options: null }),
      def({ id: "empty", options: [] }),
    ]);
    expect(fields.map((f) => f.id)).toEqual(["ok"]);
  });
});

describe("resolveSolutionGroupBy", () => {
  const defs = [def({ id: "ok" })];

  it("accepts squad, opportunity and a live field", () => {
    expect(resolveSolutionGroupBy("squad", defs)).toBe("squad");
    expect(resolveSolutionGroupBy("opportunity", defs)).toBe("opportunity");
    expect(resolveSolutionGroupBy("field:ok", defs)).toBe("field:ok");
  });

  it("falls back to status for absent, unknown, stale or ineligible values", () => {
    expect(resolveSolutionGroupBy(undefined, defs)).toBe("status");
    expect(resolveSolutionGroupBy("status", defs)).toBe("status");
    expect(resolveSolutionGroupBy("bogus", defs)).toBe("status");
    expect(resolveSolutionGroupBy("field:", defs)).toBe("status");
    expect(resolveSolutionGroupBy("field:gone", defs)).toBe("status");
    expect(resolveSolutionGroupBy("field:ok", [def({ id: "ok", objectType: "OPPORTUNITY" })])).toBe("status");
  });

  it("round-trips the field id", () => {
    expect(solutionGroupByFieldId(solutionFieldGroupByValue("abc"))).toBe("abc");
    expect(solutionGroupByFieldId("squad")).toBeNull();
  });
});

describe("buildSolutionGroups", () => {
  it("squad: one column per workspace squad plus No squad, including empty squads", () => {
    const cards = [card("1", { squad: squadA }), card("2"), card("3", { squad: { id: "deleted", name: "X", color: "#000" } })];
    const groups = buildSolutionGroups(cards, "squad", { squads: [squadA, squadB] }, false);
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Alpha", ["1"]],
      ["Beta", []],
      ["No squad", ["2", "3"]],
    ]);
  });

  it("opportunity: columns follow first appearance and only exist for opportunities with cards", () => {
    const cards = [card("1", { opp: "B" }), card("2", { opp: "A" }), card("3", { opp: "B" })];
    const groups = buildSolutionGroups(cards, "opportunity", { squads: [] }, false);
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Opp B", ["1", "3"]],
      ["Opp A", ["2"]],
    ]);
  });

  it("field: Unspecified first, then each option; stale values were already normalized to null", () => {
    const cards = [card("1", { fieldValue: "l" }), card("2", { fieldValue: null }), card("3"), card("4", { fieldValue: "s" })];
    const groups = buildSolutionGroups(cards, "field:f1", { squads: [], field: { options: def({}).options! } }, false);
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Unspecified", ["2", "3"]],
      ["Small", ["4"]],
      ["Large", ["1"]],
    ]);
    expect(groups[2].color).toBe("#f00");
    expect(new Set(groups.map((g) => g.id)).size).toBe(3);
  });

  it("an option literally named unspecified never collides with the Unspecified column", () => {
    const groups = buildSolutionGroups([], "field:f1", { squads: [], field: { options: [{ value: "unspecified", label: "Unspecified?" }] } }, false);
    expect(new Set(groups.map((g) => g.id)).size).toBe(2);
  });

  it("orders within a column by score when asked", () => {
    const cards = [card("1", { opp: "A", score: { normalizedScore: 5 } }), card("2", { opp: "A", score: { normalizedScore: 50 } })];
    const [group] = buildSolutionGroups(cards, "opportunity", { squads: [] }, true);
    expect(group.items.map((i) => i.id)).toEqual(["2", "1"]);
  });

  it("returns no columns for status or an unresolved field", () => {
    expect(buildSolutionGroups([card("1")], "status", { squads: [] }, false)).toEqual([]);
    expect(buildSolutionGroups([card("1")], "field:f1", { squads: [] }, false)).toEqual([]);
  });
});

describe("orderSolutionsForTable", () => {
  const cards = [
    card("a", { status: "SHIPPED", sortOrder: 0 }),
    card("b", { status: "IDEA", sortOrder: 2 }),
    card("c", { status: "IDEA", sortOrder: 1, score: { normalizedScore: 10 } }),
    card("d", { status: "VALIDATED", sortOrder: 0, score: { normalizedScore: 80 } }),
  ];

  it("lifecycle order then sortOrder by default", () => {
    expect(orderSolutionsForTable(cards, false).map((c) => c.id)).toEqual(["c", "b", "d", "a"]);
  });

  it("score order puts unscored last and does not mutate the input", () => {
    const before = cards.map((c) => c.id);
    expect(orderSolutionsForTable(cards, true).map((c) => c.id)).toEqual(["d", "c", "a", "b"]);
    expect(cards.map((c) => c.id)).toEqual(before);
  });
});
