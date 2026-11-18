import { describe, expect, it } from "vitest";
import { normalizeQuery, objectiveMatches, splitMatch, titleMatches } from "@/lib/okr-name-filter";

const objective = {
  title: "Reduce time to quote",
  keyResults: [{ title: "Median quote time" }, { title: "NPS score" }],
};

describe("okr name filter", () => {
  it("normalizes case and whitespace", () => {
    expect(normalizeQuery("  QuOte ")).toBe("quote");
  });

  it("matches everything for an empty query", () => {
    expect(titleMatches("anything", "   ")).toBe(true);
    expect(objectiveMatches(objective, "")).toBe(true);
  });

  it("matches titles case-insensitively", () => {
    expect(titleMatches("Grow Leads", "lead")).toBe(true);
    expect(titleMatches("Grow Leads", "xyz")).toBe(false);
  });

  it("matches an objective by its own title", () => {
    expect(objectiveMatches(objective, "REDUCE")).toBe(true);
  });

  it("matches an objective through a key result only", () => {
    expect(objectiveMatches(objective, "nps")).toBe(true);
  });

  it("does not match when nothing contains the query", () => {
    expect(objectiveMatches(objective, "partners")).toBe(false);
  });

  it("splits a title around the first match, keeping original case", () => {
    expect(splitMatch("Median Quote time", " quote ")).toEqual({ before: "Median ", match: "Quote", after: " time" });
  });

  it("returns null when there is nothing to mark", () => {
    expect(splitMatch("Median quote time", "")).toBeNull();
    expect(splitMatch("Median quote time", "nps")).toBeNull();
  });
});
