import { describe, it, expect } from "vitest";
import { cycleTiming, paceVerdict, rollupObjectives } from "@/lib/okr-cycle-rollup";

describe("rollupObjectives", () => {
  it("returns zeros for no objectives", () => {
    expect(rollupObjectives([])).toEqual({
      objectiveCount: 0,
      keyResultCount: 0,
      progress: 0,
      statusMix: { ON_TRACK: 0, AT_RISK: 0, OFF_TRACK: 0, COMPLETE: 0 },
    });
  });

  it("averages clamped progress across all KRs and tallies statuses", () => {
    const rollup = rollupObjectives([
      { status: "ON_TRACK", keyResults: [{ current: 50, target: 100 }, { current: 200, target: 100 }] },
      { status: "AT_RISK", keyResults: [{ current: 0, target: 100 }] },
      { status: "COMPLETE", keyResults: [] },
    ]);
    expect(rollup.objectiveCount).toBe(3);
    expect(rollup.keyResultCount).toBe(3);
    // (50 + 100 + 0) / 3
    expect(rollup.progress).toBe(50);
    expect(rollup.statusMix).toEqual({ ON_TRACK: 1, AT_RISK: 1, OFF_TRACK: 0, COMPLETE: 1 });
  });

  it("ignores unknown statuses in the mix but still counts the objective", () => {
    const rollup = rollupObjectives([{ status: "WEIRD", keyResults: [] }]);
    expect(rollup.objectiveCount).toBe(1);
    expect(rollup.statusMix).toEqual({ ON_TRACK: 0, AT_RISK: 0, OFF_TRACK: 0, COMPLETE: 0 });
  });

  it("treats a zero-target KR as 0% without poisoning the average", () => {
    expect(rollupObjectives([{ status: "ON_TRACK", keyResults: [{ current: 5, target: 0 }, { current: 100, target: 100 }] }]).progress).toBe(50);
  });
});

describe("cycleTiming", () => {
  const start = new Date("2026-07-01T00:00:00Z");
  const end = new Date("2026-09-29T00:00:00Z"); // 90 days

  it("is upcoming before the start", () => {
    const t = cycleTiming(start, end, new Date("2026-06-21T00:00:00Z"));
    expect(t.phase).toBe("upcoming");
    expect(t.percentElapsed).toBe(0);
    expect(t.daysUntilStart).toBe(10);
  });

  it("reports percent elapsed and days left while running", () => {
    const t = cycleTiming(start, end, new Date("2026-08-15T00:00:00Z"));
    expect(t.phase).toBe("running");
    expect(t.percentElapsed).toBe(50);
    expect(t.daysLeft).toBe(45);
  });

  it("is fully elapsed after the end", () => {
    const t = cycleTiming(start, end, new Date("2026-12-01T00:00:00Z"));
    expect(t).toMatchObject({ phase: "ended", percentElapsed: 100, daysLeft: 0 });
  });

  it("accepts ISO strings and survives a zero-length range", () => {
    const t = cycleTiming("2026-07-01T00:00:00Z", "2026-07-01T00:00:00Z", new Date("2026-07-01T00:00:00Z"));
    expect(t.percentElapsed).toBe(100);
  });
});

describe("paceVerdict", () => {
  it("is ahead / behind beyond the tolerance and on pace within it", () => {
    expect(paceVerdict(70, 50)).toBe("ahead");
    expect(paceVerdict(30, 50)).toBe("behind");
    expect(paceVerdict(55, 50)).toBe("on-pace");
    expect(paceVerdict(60, 50)).toBe("on-pace");
    expect(paceVerdict(40, 50)).toBe("on-pace");
  });
});
