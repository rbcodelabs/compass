import { describe, expect, it } from "vitest";
import {
  calculateTimelineRenderWindow,
  isTimelineIntervalRendered,
  selectTimelineIntervalsForRender,
} from "@/lib/roadmap-timeline/virtualization";

describe("native timeline horizontal virtualization", () => {
  it("bounds overscan to one-quarter viewport and clamps to maximum scroll", () => {
    expect(calculateTimelineRenderWindow(600, 400, 1840)).toEqual({ start: 500, end: 1100 });
    expect(calculateTimelineRenderWindow(5000, 400, 1840, 2000)).toEqual({ start: 1340, end: 1840 });
    expect(calculateTimelineRenderWindow(-20, 400, 1840)).toEqual({ start: 0, end: 500 });
  });

  it("renders the whole canvas when the viewport is wider", () => {
    expect(calculateTimelineRenderWindow(50, 800, 400)).toEqual({ start: 0, end: 400 });
  });

  it.each([
    [-50, { start: 600, end: 1000 }],
    [Number.NaN, { start: 600, end: 1000 }],
    [Number.POSITIVE_INFINITY, { start: 500, end: 1100 }],
  ])("normalizes requested overscan %s", (overscan, expected) => {
    expect(calculateTimelineRenderWindow(600, 400, 1840, overscan)).toEqual(expected);
  });

  it.each([
    [Number.NaN, 400, 1840],
    [0, Number.POSITIVE_INFINITY, 1840],
    [0, 400, Number.NEGATIVE_INFINITY],
    [0, -1, 1840],
  ])("returns an empty window for invalid geometry", (scrollLeft, viewportWidth, canvasWidth) => {
    expect(calculateTimelineRenderWindow(scrollLeft, viewportWidth, canvasWidth)).toEqual({ start: 0, end: 0 });
  });

  it("uses half-open intersections at render-window boundaries", () => {
    const renderWindow = { start: 500, end: 1100 };

    expect(isTimelineIntervalRendered(499, 500, renderWindow)).toBe(false);
    expect(isTimelineIntervalRendered(500, 532, renderWindow)).toBe(true);
    expect(isTimelineIntervalRendered(1099, 1100, renderWindow)).toBe(true);
    expect(isTimelineIntervalRendered(1100, 1132, renderWindow)).toBe(false);
    expect(isTimelineIntervalRendered(600, 600, renderWindow)).toBe(false);
    expect(isTimelineIntervalRendered(700, 600, renderWindow)).toBe(false);
    expect(isTimelineIntervalRendered(Number.NaN, 700, renderWindow)).toBe(false);
    expect(isTimelineIntervalRendered(0, 120, { start: 100, end: 50 })).toBe(false);
  });

  it("does not retain intervals with invalid pixel geometry", () => {
    const intervals = [
      { id: "valid", start: 10, end: 20 },
      { id: "zero", start: 30, end: 30 },
      { id: "nan", start: Number.NaN, end: 40 },
    ];

    expect(selectTimelineIntervalsForRender(
      intervals,
      { start: 0, end: 100 },
      (interval) => interval,
      new Set(["zero", "nan"]),
    )).toEqual([intervals[0]]);
  });

  it("does not retain intervals when the render window is invalid", () => {
    const interval = { id: "focused", start: 0, end: 10 };

    expect(selectTimelineIntervalsForRender(
      [interval],
      { start: 100, end: 50 },
      (candidate) => candidate,
      new Set([interval.id]),
    )).toEqual([]);
  });

  it("selects a bounded slice while retaining known focused and active items once", () => {
    const intervals = Array.from({ length: 500 }, (_, index) => ({
      id: `item-${index}`,
      start: index * 20,
      end: index * 20 + 14,
    }));
    const renderWindow = calculateTimelineRenderWindow(2200, 400, 10_000);

    const rendered = selectTimelineIntervalsForRender(
      intervals,
      renderWindow,
      (interval) => interval,
      new Set(["item-0", "item-499", "unknown"]),
    );

    expect(rendered).toHaveLength(32);
    expect(rendered[0].id).toBe("item-0");
    expect(rendered.at(-1)?.id).toBe("item-499");
    expect(rendered.filter(({ id }) => id === "item-0")).toHaveLength(1);
    expect(rendered.filter(({ id }) => id === "item-499")).toHaveLength(1);
    expect(intervals[0]).toEqual({ id: "item-0", start: 0, end: 14 });
  });
});
