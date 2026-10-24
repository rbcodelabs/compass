import { describe, expect, it } from "vitest";
import { hashRows, isLiveScope } from "@/lib/live-change-token";

describe("hashRows", () => {
  const rows = [
    { id: "1", status: "EXPLORING", sortOrder: 0 },
    { id: "2", status: "ACTIVE", sortOrder: 1 },
  ];

  it("is stable and independent of row order", () => {
    expect(hashRows([rows])).toBe(hashRows([[...rows].reverse()]));
  });

  it("changes on a status move even when updatedAt is untouched", () => {
    const moved = [{ ...rows[0], status: "VALIDATING" }, rows[1]];
    expect(hashRows([moved])).not.toBe(hashRows([rows]));
  });

  it("changes on a pure reorder, an addition and a deletion", () => {
    const base = hashRows([rows]);
    expect(hashRows([[{ ...rows[0], sortOrder: 5 }, rows[1]]])).not.toBe(base);
    expect(hashRows([[...rows, { id: "3", status: "ACTIVE", sortOrder: 2 }]])).not.toBe(base);
    expect(hashRows([[rows[0]]])).not.toBe(base);
  });

  it("does not let a row migrate between groups unnoticed", () => {
    expect(hashRows([[rows[0]], [rows[1]]])).not.toBe(hashRows([[rows[0], rows[1]], []]));
  });
});

describe("isLiveScope", () => {
  it("accepts known scopes only", () => {
    expect(isLiveScope("tasks")).toBe(true);
    expect(isLiveScope("opportunities")).toBe(true);
    expect(isLiveScope("roadmap")).toBe(true);
    expect(isLiveScope("cardSort")).toBe(true);
    expect(isLiveScope("users")).toBe(false);
    expect(isLiveScope(null)).toBe(false);
  });
});
