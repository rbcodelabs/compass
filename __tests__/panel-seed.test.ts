import { describe, it, expect, beforeEach, vi } from "vitest";
import { setPanelSeed, peekPanelSeed, clearPanelSeed, PANEL_SEED_TTL_MS } from "@/lib/panel-seed";

// The seed store is module-level state, so every test starts by clearing the
// ids it uses. There is no "clear all" export; that itself is worth knowing.
const IDS = ["a", "b"];
beforeEach(() => {
  for (const id of IDS) {
    clearPanelSeed("roadmapItem", id);
    clearPanelSeed("task", id);
  }
});

describe("panel-seed", () => {
  it("returns undefined when nothing was seeded", () => {
    expect(peekPanelSeed("roadmapItem", "a")).toBeUndefined();
  });

  it("returns the exact object that was set", () => {
    const data = { title: "Card A" };
    setPanelSeed("roadmapItem", "a", data);
    expect(peekPanelSeed("roadmapItem", "a")).toBe(data);
  });

  it("does not return the seed for item A when asked for item B", () => {
    setPanelSeed("roadmapItem", "a", { title: "Card A" });
    expect(peekPanelSeed("roadmapItem", "b")).toBeUndefined();
  });

  it("does not return a seed across panel types that share an id", () => {
    setPanelSeed("roadmapItem", "a", { title: "Card A" });
    expect(peekPanelSeed("task", "a")).toBeUndefined();
  });

  it("overwrites an earlier seed for the same type and id", () => {
    setPanelSeed("roadmapItem", "a", { title: "old" });
    setPanelSeed("roadmapItem", "a", { title: "new" });
    expect(peekPanelSeed<{ title: string }>("roadmapItem", "a")?.title).toBe("new");
  });

  it("clear removes only the targeted seed", () => {
    setPanelSeed("roadmapItem", "a", { title: "A" });
    setPanelSeed("roadmapItem", "b", { title: "B" });
    clearPanelSeed("roadmapItem", "a");
    expect(peekPanelSeed("roadmapItem", "a")).toBeUndefined();
    expect(peekPanelSeed("roadmapItem", "b")).toBeDefined();
  });

  it("clearing a seed that does not exist is a no-op", () => {
    expect(() => clearPanelSeed("roadmapItem", "never-set")).not.toThrow();
  });

  it("peek is not one-shot: repeated reads keep returning the seed until cleared", () => {
    // Documents actual behaviour. The module exposes peek/clear, not a
    // consuming read, so a seed survives any number of renders and is only
    // removed when something explicitly clears it.
    setPanelSeed("roadmapItem", "a", { title: "A" });
    expect(peekPanelSeed("roadmapItem", "a")).toBeDefined();
    expect(peekPanelSeed("roadmapItem", "a")).toBeDefined();
    clearPanelSeed("roadmapItem", "a");
    expect(peekPanelSeed("roadmapItem", "a")).toBeUndefined();
  });

  it("does not collide when an id contains the key separator", () => {
    // key = `${type}:${id}`; ("a", "b:c") vs ("a:b", "c") collide.
    setPanelSeed("a", "b:c", { n: 1 });
    expect(peekPanelSeed("a:b", "c")).toBeUndefined();
    clearPanelSeed("a", "b:c");
  });

  it("ignores and drops a seed older than the TTL", () => {
    vi.useFakeTimers();
    try {
      setPanelSeed("roadmapItem", "a", { n: 1 });
      vi.advanceTimersByTime(PANEL_SEED_TTL_MS + 1);
      expect(peekPanelSeed("roadmapItem", "a")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
