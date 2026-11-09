// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { CollisionDescriptor, CollisionDetection } from "@dnd-kit/core";
import { useStableBoardCollision } from "@/components/patterns/board-dock-dnd";

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
