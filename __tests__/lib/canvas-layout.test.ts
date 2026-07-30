import { describe, it, expect } from "vitest";
import {
  computeCanvasLayout,
  type CanvasLayoutInput,
  type CanvasLayoutEdge,
  type CanvasNodeType,
} from "@/lib/canvas/layout";

function makeNode(
  id: string,
  type: CanvasNodeType = "objective",
  overrides: Partial<CanvasLayoutInput> = {}
): CanvasLayoutInput {
  return { id, type, position: null, ...overrides };
}

describe("computeCanvasLayout", () => {
  it("returns an empty array for empty input", async () => {
    await expect(computeCanvasLayout([], [])).resolves.toEqual([]);
  });

  it("computes positions for unpinned nodes", async () => {
    const result = await computeCanvasLayout(
      [makeNode("a"), makeNode("b"), makeNode("c")],
      []
    );

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

  it("preserves the saved position verbatim for pinned nodes", async () => {
    const result = await computeCanvasLayout(
      [makeNode("pinned-1", "objective", { position: { x: 123.5, y: -45, pinned: true } })],
      []
    );

    expect(result).toEqual([{ id: "pinned-1", type: "objective", x: 123.5, y: -45 }]);
  });

  it("does not treat a saved-but-unpinned position as fixed", async () => {
    const result = await computeCanvasLayout(
      [makeNode("saved-unpinned", "objective", { position: { x: 999, y: 999, pinned: false } })],
      []
    );

    // Unpinned means ELK computes placement — it should not echo back the
    // arbitrary saved coordinates verbatim.
    expect(result[0]).not.toMatchObject({ x: 999, y: 999 });
  });

  it("handles a mix of pinned and unpinned nodes", async () => {
    const result = await computeCanvasLayout(
      [
        makeNode("pinned", "objective", { position: { x: 10, y: 20, pinned: true } }),
        makeNode("unpinned-1"),
        makeNode("unpinned-2"),
      ],
      []
    );

    expect(result).toHaveLength(3);
    const pinnedNode = result.find((n) => n.id === "pinned");
    expect(pinnedNode).toMatchObject({ x: 10, y: 20 });

    const unpinnedNodes = result.filter((n) => n.id !== "pinned");
    for (const node of unpinnedNodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }
  });

  it("lays out a mixed multi-type graph without error, with all coordinates finite", async () => {
    const nodes: CanvasLayoutInput[] = [
      makeNode("obj-1", "objective"),
      makeNode("kr-1", "keyResult"),
      makeNode("opp-1", "opportunity"),
      makeNode("sol-1", "solution"),
      makeNode("as-1", "assumption"),
      makeNode("exp-1", "experiment"),
      makeNode("item-1", "roadmapItem"),
    ];
    const edges: CanvasLayoutEdge[] = [
      { id: "e1", source: "obj-1", target: "kr-1" },
      { id: "e2", source: "kr-1", target: "opp-1" },
      { id: "e3", source: "opp-1", target: "sol-1" },
      { id: "e4", source: "sol-1", target: "as-1" },
      { id: "e5", source: "as-1", target: "exp-1" },
      { id: "e6", source: "sol-1", target: "item-1" },
    ];

    const result = await computeCanvasLayout(nodes, edges);

    expect(result).toHaveLength(7);
    for (const node of result) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }
  });

  it("places connected nodes in different ELK layers (distinct x for a chain along elk.direction=RIGHT)", async () => {
    const nodes: CanvasLayoutInput[] = [
      makeNode("obj-1", "objective"),
      makeNode("kr-1", "keyResult"),
      makeNode("opp-1", "opportunity"),
    ];
    const edges: CanvasLayoutEdge[] = [
      { id: "e1", source: "obj-1", target: "kr-1" },
      { id: "e2", source: "kr-1", target: "opp-1" },
    ];

    const result = await computeCanvasLayout(nodes, edges);
    const byId = new Map(result.map((n) => [n.id, n]));

    // Not asserting exact pixel values — just that a 3-hop chain doesn't
    // collapse onto the same layer.
    const xs = new Set([byId.get("obj-1")?.x, byId.get("kr-1")?.x, byId.get("opp-1")?.x]);
    expect(xs.size).toBeGreaterThan(1);
  });

  it("still positions a disconnected/orphan node with a finite coordinate", async () => {
    const nodes: CanvasLayoutInput[] = [
      makeNode("obj-1", "objective"),
      makeNode("kr-1", "keyResult"),
      makeNode("orphan-item", "roadmapItem"),
    ];
    const edges: CanvasLayoutEdge[] = [{ id: "e1", source: "obj-1", target: "kr-1" }];

    const result = await computeCanvasLayout(nodes, edges);
    const orphan = result.find((n) => n.id === "orphan-item");

    expect(orphan).toBeDefined();
    expect(Number.isFinite(orphan!.x)).toBe(true);
    expect(Number.isFinite(orphan!.y)).toBe(true);
  });

  it("lays out several hundred mixed-type nodes within a reasonable time budget", async () => {
    // Mirrors the seed script's new target scale (~80 objectives plus the
    // OST + Roadmap graph derived from them) rather than the old
    // 500-Objective-only budget.
    const types: CanvasNodeType[] = [
      "objective",
      "keyResult",
      "opportunity",
      "solution",
      "assumption",
      "experiment",
      "roadmapItem",
    ];
    const nodes: CanvasLayoutInput[] = Array.from({ length: 600 }, (_, i) =>
      makeNode(`n-${i}`, types[i % types.length])
    );
    const edges: CanvasLayoutEdge[] = Array.from({ length: 400 }, (_, i) => ({
      id: `edge-${i}`,
      source: `n-${i}`,
      target: `n-${(i + 1) % 600}`,
    }));

    const start = Date.now();
    const result = await computeCanvasLayout(nodes, edges);
    const elapsedMs = Date.now() - start;

    expect(result).toHaveLength(600);
    expect(elapsedMs).toBeLessThan(5000);
  }, 10_000);
});
