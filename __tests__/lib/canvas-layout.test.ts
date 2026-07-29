import { describe, it, expect } from "vitest";
import {
  computeObjectiveLayout,
  type ObjectiveLayoutInput,
} from "@/lib/canvas/layout";

function makeObjective(
  id: string,
  overrides: Partial<ObjectiveLayoutInput> = {}
): ObjectiveLayoutInput {
  return {
    id,
    title: `Objective ${id}`,
    keyResults: [
      { id: `${id}-kr-1`, title: "KR 1", current: 5, target: 10, unit: null },
    ],
    position: null,
    ...overrides,
  };
}

describe("computeObjectiveLayout", () => {
  it("returns an empty array for empty input", async () => {
    await expect(computeObjectiveLayout([])).resolves.toEqual([]);
  });

  it("computes positions for unpinned objectives", async () => {
    const result = await computeObjectiveLayout([
      makeObjective("a"),
      makeObjective("b"),
      makeObjective("c"),
    ]);

    expect(result).toHaveLength(3);
    for (const node of result) {
      expect(typeof node.x).toBe("number");
      expect(typeof node.y).toBe("number");
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }
    // ELK should not stack every node at the exact same point.
    const distinctPositions = new Set(result.map((n) => `${n.x},${n.y}`));
    expect(distinctPositions.size).toBeGreaterThan(1);
  });

  it("preserves the saved position verbatim for pinned objectives", async () => {
    const result = await computeObjectiveLayout([
      makeObjective("pinned-1", {
        position: { x: 123.5, y: -45, pinned: true },
      }),
    ]);

    expect(result).toEqual([
      {
        id: "pinned-1",
        x: 123.5,
        y: -45,
        data: {
          id: "pinned-1",
          title: "Objective pinned-1",
          keyResults: [
            {
              id: "pinned-1-kr-1",
              title: "KR 1",
              current: 5,
              target: 10,
              unit: null,
            },
          ],
        },
      },
    ]);
  });

  it("does not treat a saved-but-unpinned position as fixed", async () => {
    const result = await computeObjectiveLayout([
      makeObjective("saved-unpinned", {
        position: { x: 999, y: 999, pinned: false },
      }),
    ]);

    // Unpinned means ELK computes placement — it should not echo back the
    // arbitrary saved coordinates verbatim.
    expect(result[0]).not.toMatchObject({ x: 999, y: 999 });
  });

  it("handles a mix of pinned and unpinned objectives", async () => {
    const result = await computeObjectiveLayout([
      makeObjective("pinned", { position: { x: 10, y: 20, pinned: true } }),
      makeObjective("unpinned-1"),
      makeObjective("unpinned-2"),
    ]);

    expect(result).toHaveLength(3);
    const pinnedNode = result.find((n) => n.id === "pinned");
    expect(pinnedNode).toMatchObject({ x: 10, y: 20 });

    const unpinnedNodes = result.filter((n) => n.id !== "pinned");
    for (const node of unpinnedNodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }
  });

  it("strips the `position` field out of the returned node data", async () => {
    const result = await computeObjectiveLayout([makeObjective("a")]);
    expect(result[0].data).not.toHaveProperty("position");
    expect(result[0].data.id).toBe("a");
    expect(result[0].data.title).toBe("Objective a");
  });

  it("handles objectives with zero key results", async () => {
    const result = await computeObjectiveLayout([
      makeObjective("no-krs", { keyResults: [] }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].data.keyResults).toEqual([]);
  });

  it("lays out 500 objectives within a reasonable time budget", async () => {
    const objectives = Array.from({ length: 500 }, (_, i) =>
      makeObjective(`obj-${i}`, {
        keyResults: [
          { id: `obj-${i}-kr-1`, title: "KR 1", current: 1, target: 4, unit: null },
          { id: `obj-${i}-kr-2`, title: "KR 2", current: 2, target: 4, unit: "%" },
        ],
      })
    );

    const start = Date.now();
    const result = await computeObjectiveLayout(objectives);
    const elapsedMs = Date.now() - start;

    expect(result).toHaveLength(500);
    expect(elapsedMs).toBeLessThan(5000);
  }, 10_000);
});
