import { describe, expect, it } from "vitest";
import {
  createTimelineLaneKey,
  packTimelineIntervals,
} from "@/lib/roadmap-timeline/lane-packing";

describe("native timeline lane packing", () => {
  it("builds the canonical horizon and squad lane key", () => {
    expect(createTimelineLaneKey("NOW", "squad-a")).toBe("NOW:squad-a");
    expect(createTimelineLaneKey("NEXT", null)).toBe("NEXT:unassigned");
  });

  it("rejects ambiguous canonical lane-key parts", () => {
    expect(() => createTimelineLaneKey("", "squad-a")).toThrow(RangeError);
    expect(() => createTimelineLaneKey("  ", "squad-a")).toThrow(RangeError);
    expect(() => createTimelineLaneKey(" NOW", "squad-a")).toThrow(RangeError);
    expect(() => createTimelineLaneKey("NOW:OTHER", "squad-a")).toThrow(RangeError);
    expect(() => createTimelineLaneKey("NOW", "")).toThrow(RangeError);
    expect(() => createTimelineLaneKey("NOW", "  ")).toThrow(RangeError);
    expect(() => createTimelineLaneKey("NOW", " squad-a ")).toThrow(RangeError);
    expect(() => createTimelineLaneKey("NOW", "unassigned")).toThrow(RangeError);
  });

  it("stacks inclusive boundary collisions into deterministic tracks", () => {
    const packed = packTimelineIntervals([
      { id: "c", laneKey: "NOW:squad-a", start: "2026-09-03", end: "2026-09-04" },
      { id: "b", laneKey: "NOW:squad-a", start: "2026-09-02", end: "2026-09-03" },
      { id: "a", laneKey: "NOW:squad-a", start: "2026-09-01", end: "2026-09-02" },
    ]);

    expect(packed.map(({ id, track, trackCount }) => ({ id, track, trackCount }))).toEqual([
      { id: "a", track: 0, trackCount: 2 },
      { id: "b", track: 1, trackCount: 2 },
      { id: "c", track: 0, trackCount: 2 },
    ]);
  });

  it("sorts ties by start, end, then id independently of input order", () => {
    const intervals = [
      { id: "z", laneKey: "NOW:unassigned", start: "2026-09-01", end: "2026-09-03" },
      { id: "b", laneKey: "NOW:unassigned", start: "2026-09-01", end: "2026-09-02" },
      { id: "a", laneKey: "NOW:unassigned", start: "2026-09-01", end: "2026-09-02" },
    ] as const;

    const forward = packTimelineIntervals(intervals);
    const reverse = packTimelineIntervals([...intervals].reverse());

    expect(forward.map(({ id, track }) => ({ id, track }))).toEqual([
      { id: "a", track: 0 },
      { id: "b", track: 1 },
      { id: "z", track: 2 },
    ]);
    expect(reverse).toEqual(forward);
    expect(intervals.map((interval) => interval.id)).toEqual(["z", "b", "a"]);
  });

  it("packs different canonical lanes independently", () => {
    const packed = packTimelineIntervals([
      { id: "now", laneKey: "NOW:unassigned", start: "2026-09-01", end: "2026-09-02" },
      { id: "next", laneKey: "NEXT:unassigned", start: "2026-09-01", end: "2026-09-02" },
    ]);

    expect(packed.map(({ id, track, trackCount }) => ({ id, track, trackCount }))).toEqual([
      { id: "next", track: 0, trackCount: 1 },
      { id: "now", track: 0, trackCount: 1 },
    ]);
  });

  it("reuses a track only after an inclusive interval has a full-day gap", () => {
    const packed = packTimelineIntervals([
      { id: "first", laneKey: "NOW:squad-a", start: "2026-09-01", end: "2026-09-01" },
      { id: "gap", laneKey: "NOW:squad-a", start: "2026-09-02", end: "2026-09-02" },
    ]);

    expect(packed.map(({ track }) => track)).toEqual([0, 0]);
  });

  it("assigns a dense lane one track per simultaneous interval", () => {
    const packed = packTimelineIntervals(Array.from({ length: 8 }, (_, index) => ({
      id: `item-${index}`,
      laneKey: "NOW:squad-a" as const,
      start: "2026-09-01",
      end: "2026-09-01",
    })));

    expect(packed.map(({ track }) => track)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(packed.map(({ trackCount }) => trackCount))).toEqual(new Set([8]));
  });

  it("keeps deterministic lowest-track assignment at the bounded 500-item corpus", () => {
    const packed = packTimelineIntervals(Array.from({ length: 500 }, (_, index) => ({
      id: `item-${String(index).padStart(3, "0")}`,
      laneKey: "NOW:squad-a" as const,
      start: "2026-09-01",
      end: "2026-09-01",
    })));

    expect(packed).toHaveLength(500);
    expect(packed[499]).toMatchObject({ track: 499, trackCount: 500 });
  });

  it("returns copied packed records without mutating source objects", () => {
    const source = { id: "item", laneKey: "NOW:squad-a" as const, start: "2026-09-01", end: "2026-09-01" };
    const packed = packTimelineIntervals([source]);

    expect(packed[0]).not.toBe(source);
    expect(source).toEqual({ id: "item", laneKey: "NOW:squad-a", start: "2026-09-01", end: "2026-09-01" });
  });

  it("rejects duplicate IDs because retention and focus identity must be unique", () => {
    expect(() => packTimelineIntervals([
      { id: "duplicate", laneKey: "NOW:squad-a", start: "2026-09-01", end: "2026-09-01" },
      { id: "duplicate", laneKey: "NEXT:squad-a", start: "2026-09-01", end: "2026-09-01" },
    ])).toThrow(RangeError);
  });

  it("rejects invalid intervals", () => {
    expect(() => packTimelineIntervals([
      { id: "bad", laneKey: "NOW:unassigned", start: "2026-09-02", end: "2026-09-01" },
    ])).toThrow(RangeError);
    expect(() => packTimelineIntervals([
      { id: "bad-lane", laneKey: "NOW:" as const, start: "2026-09-01", end: "2026-09-01" },
    ])).toThrow(RangeError);
  });
});
