import { describe, it, expect } from "vitest";
import { clampProgress, averageProgress, STATUS_BADGE } from "@/lib/okrs";

describe("clampProgress", () => {
  it("returns 0 when target is 0 (avoids divide-by-zero)", () => {
    expect(clampProgress(50, 0)).toBe(0);
  });

  it("computes a simple percentage", () => {
    expect(clampProgress(50, 100)).toBe(50);
  });

  it("clamps above 100 to 100", () => {
    expect(clampProgress(150, 100)).toBe(100);
  });

  it("clamps negative current to 0", () => {
    expect(clampProgress(-10, 100)).toBe(0);
  });

  it("rounds to the nearest integer", () => {
    expect(clampProgress(1, 3)).toBe(33);
  });
});

describe("averageProgress", () => {
  it("returns 0 for an empty list", () => {
    expect(averageProgress([])).toBe(0);
  });

  it("averages a single KR", () => {
    expect(averageProgress([{ current: 50, target: 100 }])).toBe(50);
  });

  it("averages multiple KRs", () => {
    expect(
      averageProgress([
        { current: 100, target: 100 },
        { current: 0, target: 100 },
      ])
    ).toBe(50);
  });

  it("ignores zero-target KRs in the sum but still divides by full count", () => {
    // Matches the objective-row.tsx original behavior: a zero-target KR
    // contributes 0 to the sum but still counts toward the denominator.
    expect(
      averageProgress([
        { current: 50, target: 100 },
        { current: 10, target: 0 },
      ])
    ).toBe(25);
  });

  it("clamps individual KR contributions above 100 before averaging", () => {
    expect(
      averageProgress([
        { current: 200, target: 100 },
        { current: 0, target: 100 },
      ])
    ).toBe(50);
  });
});

describe("STATUS_BADGE", () => {
  it("has an entry for every ObjectiveStatus value", () => {
    expect(Object.keys(STATUS_BADGE).sort()).toEqual(
      ["AT_RISK", "COMPLETE", "OFF_TRACK", "ON_TRACK"].sort()
    );
  });

  it("gives each status a label and className", () => {
    for (const badge of Object.values(STATUS_BADGE)) {
      expect(badge.label).toBeTruthy();
      expect(badge.className).toBeTruthy();
    }
  });
});
