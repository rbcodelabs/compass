// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { CollisionDescriptor, CollisionDetection } from "@dnd-kit/core";
import { cardFirstCollisionDetection, dockAwareCollisionDetection, useStableBoardCollision } from "@/components/patterns/board-dock-dnd";

/** A collision detection whose answer the test controls, standing in for closestCenter / pointerWithin. */
function scripted() {
  let answer: string | null = "column-A";
  const base: CollisionDetection = () => (answer === null ? [] : ([{ id: answer }] as CollisionDescriptor[]));
  return { base, answer: (id: string | null) => { answer = id; } };
}
const args = {} as Parameters<CollisionDetection>[0];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
});

describe("useStableBoardCollision", () => {
  it("passes the base detection through while nothing has moved", () => {
    const s = scripted();
    const { result } = renderHook(() => useStableBoardCollision(s.base));
    expect(result.current.collisionDetection(args)).toEqual([{ id: "column-A" }]);
    s.answer("column-B");
    expect(result.current.collisionDetection(args)).toEqual([{ id: "column-B" }]);
  });

  it("after the board moved the card, repeats the last answer so the new geometry cannot flip it straight back", () => {
    const s = scripted();
    const { result } = renderHook(() => useStableBoardCollision(s.base));
    result.current.collisionDetection(args); // over A
    s.answer("column-B");
    result.current.collisionDetection(args); // over B: the board moves the card into B
    result.current.noteMoved();
    // The card remounted in B and the geometry now says A. A ping-pong would act on this; the guard does not.
    s.answer("column-A");
    for (let i = 0; i < 100; i++) expect(result.current.collisionDetection(args)).toEqual([{ id: "column-B" }]);
  });

  it("trusts the base detection again two animation frames later", () => {
    const s = scripted();
    const { result } = renderHook(() => useStableBoardCollision(s.base));
    result.current.collisionDetection(args);
    result.current.noteMoved();
    s.answer("column-C");
    expect(result.current.collisionDetection(args)).toEqual([{ id: "column-A" }]);
    act(() => { vi.advanceTimersByTime(40); });
    expect(result.current.collisionDetection(args)).toEqual([{ id: "column-C" }]);
  });

  it("reset clears the freeze and the remembered target at the end of a drag", () => {
    const s = scripted();
    const { result } = renderHook(() => useStableBoardCollision(s.base));
    result.current.collisionDetection(args);
    result.current.noteMoved();
    result.current.reset();
    s.answer(null);
    expect(result.current.collisionDetection(args)).toEqual([]);
    s.answer("column-D");
    expect(result.current.collisionDetection(args)).toEqual([{ id: "column-D" }]);
  });

  it("keeps a stable function identity across renders, so DndContext does not re-measure", () => {
    const s = scripted();
    const { result, rerender } = renderHook(() => useStableBoardCollision(s.base));
    const first = result.current.collisionDetection;
    rerender();
    expect(result.current.collisionDetection).toBe(first);
  });
});

describe("cardFirstCollisionDetection", () => {
  type Rect = { left: number; top: number; width: number; height: number; right: number; bottom: number };
  const rect = (left: number, top: number, width: number, height: number): Rect => ({ left, top, width, height, right: left + width, bottom: top + height });
  const container = (id: string, data: Record<string, unknown>) => ({ id, key: id, data: { current: data }, disabled: false, node: { current: null }, rect: { current: null } });

  /**
   * One tall column (centre y=400) holding cards One (centre y=410) and Two (centre y=520), with a second, empty column to its right.
   * The dragged card is Two; `top` places the dragged rect.
   */
  function scene(top: number, left = 20) {
    const rects = new Map<string, Rect>([
      ["column-EXPLORING", rect(0, 0, 300, 800)],
      ["one", rect(20, 360, 260, 100)],
      ["two", rect(20, 470, 260, 100)],
      ["column-ACTIVE", rect(320, 0, 300, 800)],
    ]);
    const droppableContainers = [
      container("column-EXPLORING", { status: "EXPLORING" }),
      container("one", { sortable: { containerId: "x", index: 0, items: ["one", "two"] } }),
      container("two", { sortable: { containerId: "x", index: 1, items: ["one", "two"] } }),
      container("column-ACTIVE", { status: "ACTIVE" }),
    ];
    return {
      active: { id: "two", data: { current: {} }, rect: { current: { initial: null, translated: null } } },
      collisionRect: rect(left, top, 260, 100),
      droppableRects: rects,
      droppableContainers,
      pointerCoordinates: null,
    } as unknown as Parameters<CollisionDetection>[0];
  }

  it("documents the bug it fixes: closestCenter prefers the tall column over the card under the pointer", () => {
    // Dragged centre y=330: 70 from the column's centre (400) but 80 from card One's (410).
    expect(dockAwareCollisionDetection(scene(280))[0].id).toBe("column-EXPLORING");
  });

  it("answers the card the dragged rect overlaps, not the column that contains it", () => {
    expect(cardFirstCollisionDetection(scene(280))[0].id).toBe("one");
  });

  it("picks the closest of several overlapped cards, never the dragged card itself", () => {
    // Dragged rect (card Two) spans One (360-460) and its own slot (470-570); its centre (y=470) is closer to its own centre
    // (50) than to One's (60), but the card being dragged is not a drop target for itself, so One answers.
    expect(cardFirstCollisionDetection(scene(420))[0].id).toBe("one");
  });

  it("a cross-column drag whose rect still overlaps the dragged card's original slot answers the column it is heading for, not itself", () => {
    // Rect x 250-510 overlaps Two's own slot (x 20-280) and reaches into the ACTIVE column (x 320+); it overlaps no other card.
    // Before the fix the card's own slot was the only overlapped card, so the answer was always "two" and the drag could not leave.
    expect(cardFirstCollisionDetection(scene(470, 250))[0].id).toBe("column-ACTIVE");
  });

  it("falls back to the nearest column when the dragged rect overlaps no card (empty column, gap below the cards)", () => {
    expect(cardFirstCollisionDetection(scene(300, 330))[0].id).toBe("column-ACTIVE");
  });

  it("still lets a dock tab win when the pointer is on it", () => {
    const args = scene(280);
    const tab = container("tab-ACTIVE", { status: "ACTIVE", dockTab: true });
    (args.droppableContainers as unknown[]).push(tab);
    (args.droppableRects as Map<string, Rect>).set("tab-ACTIVE", rect(900, 10, 40, 100));
    (args as { pointerCoordinates: { x: number; y: number } }).pointerCoordinates = { x: 910, y: 50 };
    expect(cardFirstCollisionDetection(args)[0].id).toBe("tab-ACTIVE");
  });
});
