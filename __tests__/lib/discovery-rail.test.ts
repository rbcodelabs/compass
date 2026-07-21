import { describe, it, expect } from "vitest";
import { filterOpportunitiesByTitle, groupOpportunitiesByStatus } from "@/lib/discovery-rail";

const opportunities = [
  { id: "1", title: "Improve onboarding", status: "EXPLORING" as const },
  { id: "2", title: "Reduce churn", status: "VALIDATING" as const },
  { id: "3", title: "Speed up checkout", status: "PRIORITIZED" as const },
  { id: "4", title: "Mobile app parity", status: "ACTIVE" as const },
  { id: "5", title: "Legacy import tool", status: "ARCHIVED" as const },
];

describe("filterOpportunitiesByTitle", () => {
  it("returns all opportunities when the query is empty", () => {
    expect(filterOpportunitiesByTitle(opportunities, "")).toHaveLength(5);
  });

  it("returns all opportunities when the query is whitespace-only", () => {
    expect(filterOpportunitiesByTitle(opportunities, "   ")).toHaveLength(5);
  });

  it("filters case-insensitively by title substring", () => {
    const result = filterOpportunitiesByTitle(opportunities, "CHURN");
    expect(result.map((o) => o.id)).toEqual(["2"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterOpportunitiesByTitle(opportunities, "nonexistent")).toEqual([]);
  });
});

describe("groupOpportunitiesByStatus", () => {
  it("groups opportunities into active-status buckets plus a separate archived bucket", () => {
    const { active, archived } = groupOpportunitiesByStatus(opportunities);
    expect(active.EXPLORING.map((o) => o.id)).toEqual(["1"]);
    expect(active.VALIDATING.map((o) => o.id)).toEqual(["2"]);
    expect(active.PRIORITIZED.map((o) => o.id)).toEqual(["3"]);
    expect(active.ACTIVE.map((o) => o.id)).toEqual(["4"]);
    expect(archived.map((o) => o.id)).toEqual(["5"]);
  });

  it("returns empty buckets for an empty input", () => {
    const { active, archived } = groupOpportunitiesByStatus([]);
    expect(active.EXPLORING).toEqual([]);
    expect(active.VALIDATING).toEqual([]);
    expect(active.PRIORITIZED).toEqual([]);
    expect(active.ACTIVE).toEqual([]);
    expect(archived).toEqual([]);
  });

  it("puts everything into archived when all opportunities are archived", () => {
    const allArchived = opportunities.map((o) => ({ ...o, status: "ARCHIVED" as const }));
    const { active, archived } = groupOpportunitiesByStatus(allArchived);
    expect(active.EXPLORING).toEqual([]);
    expect(active.VALIDATING).toEqual([]);
    expect(active.PRIORITIZED).toEqual([]);
    expect(active.ACTIVE).toEqual([]);
    expect(archived).toHaveLength(5);
  });
});
