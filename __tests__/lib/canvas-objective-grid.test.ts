import { describe, it, expect } from "vitest";
import {
  computeObjectiveGridPositions,
  NODE_SIZE,
} from "@/lib/canvas/layout";

const CELL_W = NODE_SIZE.objective.width + 80;
const CELL_H = NODE_SIZE.objective.height + 60;

function bbox(positions: Map<string, { x: number; y: number }>) {
  const xs = [...positions.values()].map((p) => p.x);
  const ys = [...positions.values()].map((p) => p.y);
  return {
    width: Math.max(...xs) + NODE_SIZE.objective.width - Math.min(...xs),
    height: Math.max(...ys) + NODE_SIZE.objective.height - Math.min(...ys),
  };
}

/** The zoom fitView would pick to frame the whole grid in a landscape pane,
 * ignoring React Flow's minZoom clamp (that clamp is the interactive floor,
 * not a property of the layout). Mirrors getViewportForBounds' math. */
function fitZoom(
  positions: Map<string, { x: number; y: number }>,
  paneW = 1060,
  paneH = 457,
  padding = 0.1
) {
  const { width, height } = bbox(positions);
  return Math.min(
    (paneW * (1 - padding)) / width,
    (paneH * (1 - padding)) / height
  );
}

describe("computeObjectiveGridPositions", () => {
  it("returns an empty map for no objectives", () => {
    expect(computeObjectiveGridPositions([]).size).toBe(0);
  });

  it("places a single objective at the origin", () => {
    const pos = computeObjectiveGridPositions(["a"]);
    expect(pos.get("a")).toEqual({ x: 0, y: 0 });
  });

  it("lays out ids in row-major order, one row until cols is reached", () => {
    // 4 ids → cols = round(sqrt(4*2.2)) = round(2.97) = 3
    const ids = ["a", "b", "c", "d"];
    const pos = computeObjectiveGridPositions(ids);
    expect(pos.get("a")).toEqual({ x: 0, y: 0 });
    expect(pos.get("b")).toEqual({ x: CELL_W, y: 0 });
    expect(pos.get("c")).toEqual({ x: 2 * CELL_W, y: 0 });
    // wraps to the next row
    expect(pos.get("d")).toEqual({ x: 0, y: CELL_H });
  });

  it("is deterministic and stable for the same input order", () => {
    const ids = Array.from({ length: 17 }, (_, i) => `o${i}`);
    const a = computeObjectiveGridPositions(ids);
    const b = computeObjectiveGridPositions(ids);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it("assigns a unique position to every objective (no overlaps)", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `o${i}`);
    const pos = computeObjectiveGridPositions(ids);
    const keys = new Set([...pos.values()].map((p) => `${p.x},${p.y}`));
    expect(keys.size).toBe(ids.length);
  });

  it("biases wide: more columns than rows for typical counts", () => {
    const ids = Array.from({ length: 31 }, (_, i) => `o${i}`);
    const pos = computeObjectiveGridPositions(ids);
    const { width, height } = bbox(pos);
    expect(width).toBeGreaterThan(height);
  });

  it("stays readable at realistic scale — fits above the 0.2 interactive floor up to ~60 objectives", () => {
    // The interactive minZoom is 0.2 (canvas-flow.tsx). For the grid to show
    // every Objective on load without being clamped, its fit zoom must be
    // >= 0.2 across the realistic range. Contrast: the ELK layout needs
    // ~0.03 at 30 objectives — that's the bug this grid fixes.
    for (const n of [5, 10, 20, 30, 45, 60]) {
      const ids = Array.from({ length: n }, (_, i) => `o${i}`);
      const z = fitZoom(computeObjectiveGridPositions(ids));
      expect(z).toBeGreaterThanOrEqual(0.2);
    }
  });

  it("small grids fit at a high zoom — documenting why the fit call must cap maxZoom to stay in the T0 band", () => {
    // For small Objective counts the grid is physically small, so an
    // uncapped fitView would zoom IN past the T0/T1 threshold (0.4, see
    // tiers.ts) and the auto-fit would land in Cycle, not Portfolio. The
    // grid geometry alone can't prevent that; canvas-flow.tsx caps the T0
    // fit with fitViewOptions.maxZoom below 0.4 and pins tier=T0 on load.
    // This test pins that expectation: a handful of objectives really does
    // fit above 0.4, which is exactly why the cap exists.
    const z = fitZoom(computeObjectiveGridPositions(ids(12)));
    expect(z).toBeGreaterThan(0.4);
  });
});

function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `o${i}`);
}
