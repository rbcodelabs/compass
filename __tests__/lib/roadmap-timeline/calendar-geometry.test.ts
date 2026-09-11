import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  clampTimelineRange,
  dateToTimelinePosition,
  inclusiveDayCount,
  positionToInclusiveCalendarDate,
  positionToTimelineDate,
  resizeTimelineRange,
  timelinePixelDeltaToDays,
} from "@/lib/roadmap-timeline/calendar-geometry";

describe("native timeline calendar geometry", () => {
  it("uses inclusive UTC calendar dates without DST drift", () => {
    expect(inclusiveDayCount("2026-08-31", "2026-08-31")).toBe(1);
    expect(inclusiveDayCount("2026-08-31", "2026-09-13")).toBe(14);
    expect(inclusiveDayCount("2028-02-28", "2028-03-01")).toBe(3);
    expect(addCalendarDays("2026-03-07", 2)).toBe("2026-03-09");
    expect(addCalendarDays("2026-10-31", 2)).toBe("2026-11-02");
    expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("round trips dates through a logical viewport", () => {
    const position = dateToTimelinePosition("2026-10-15", "2026-07-01", "2027-01-01", 1840);

    expect(positionToTimelineDate(position, "2026-07-01", "2027-01-01", 1840)).toBe("2026-10-15");
  });

  it("clamps scheduling to the last inclusive date", () => {
    expect(positionToInclusiveCalendarDate(1840, "2026-07-01", "2027-01-01", 1840)).toBe("2026-12-31");
    expect(positionToInclusiveCalendarDate(-20, "2026-07-01", "2027-01-01", 1840)).toBe("2026-07-01");
  });

  it("preserves duration when moves cross viewport boundaries", () => {
    expect(clampTimelineRange("2026-06-15", "2026-06-28", "2026-07-01", "2026-12-31")).toEqual({
      start: "2026-07-01",
      end: "2026-07-14",
    });
    expect(clampTimelineRange("2027-01-03", "2027-01-05", "2026-07-01", "2026-12-31")).toEqual({
      start: "2026-12-29",
      end: "2026-12-31",
    });
    expect(clampTimelineRange("2026-08-01", "2026-08-03", "2026-07-01", "2026-12-31")).toEqual({
      start: "2026-08-01",
      end: "2026-08-03",
    });
  });

  it("clamps a range wider than the viewport to the entire viewport", () => {
    expect(clampTimelineRange("2026-01-01", "2027-12-31", "2026-07-01", "2026-12-31")).toEqual({
      start: "2026-07-01",
      end: "2026-12-31",
    });
  });

  it("collapses a resize at the opposite edge instead of inverting the range", () => {
    expect(resizeTimelineRange("2026-08-10", "2026-08-20", "left", "2026-08-25")).toEqual({
      start: "2026-08-20",
      end: "2026-08-20",
    });
    expect(resizeTimelineRange("2026-08-10", "2026-08-20", "right", "2026-08-01")).toEqual({
      start: "2026-08-10",
      end: "2026-08-10",
    });
  });

  it("converts pixel movement to whole calendar days", () => {
    expect(timelinePixelDeltaToDays(48, 12)).toBe(4);
    expect(timelinePixelDeltaToDays(-24, 12)).toBe(-2);
    expect(timelinePixelDeltaToDays(48, 0)).toBe(0);
  });

  it.each(["2026-02-29", "2026-13-01", "2026-09-1", "2026-09-01T00:00:00Z", "not-a-date"])(
    "rejects invalid or non-canonical date %s",
    (date) => {
      expect(() => addCalendarDays(date, 1)).toThrow(RangeError);
    },
  );

  it("rejects inverted ranges and invalid viewport geometry", () => {
    expect(() => inclusiveDayCount("2026-09-02", "2026-09-01")).toThrow(RangeError);
    expect(() => dateToTimelinePosition("2026-09-01", "2026-09-01", "2026-09-01", 100)).toThrow(RangeError);
    expect(() => positionToTimelineDate(10, "2026-09-01", "2026-10-01", 0)).toThrow(RangeError);
  });
});
