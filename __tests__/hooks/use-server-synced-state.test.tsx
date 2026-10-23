// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useServerSyncedState } from "@/hooks/use-server-synced-state";
import { planFlip } from "@/hooks/use-flip-animation";

afterEach(cleanup);

type Source = { items: string[] };
const build = (s: Source) => s.items.map((i) => i.toUpperCase());

function mount(initial: Source, busy = false) {
  return renderHook(
    ({ source, busy }: { source: Source; busy: boolean }) => useServerSyncedState(source, build, busy),
    { initialProps: { source: initial, busy } },
  );
}

describe("useServerSyncedState", () => {
  it("seeds from the source", () => {
    const hook = mount({ items: ["a"] });
    expect(hook.result.current.state).toEqual(["A"]);
    expect(hook.result.current.generation).toBe(0);
  });

  it("adopts a new source when idle and bumps the generation", () => {
    const hook = mount({ items: ["a"] });
    hook.rerender({ source: { items: ["a", "b"] }, busy: false });
    expect(hook.result.current.state).toEqual(["A", "B"]);
    expect(hook.result.current.generation).toBe(1);
  });

  it("keeps optimistic local edits until a new source arrives", () => {
    const hook = mount({ items: ["a"] });
    act(() => hook.result.current.setState(["LOCAL"]));
    hook.rerender({ source: hook.result.current ? { items: ["a"] } : { items: [] }, busy: false });
    // A fresh-but-equal source while idle is server truth and replaces the local edit.
    expect(hook.result.current.state).toEqual(["A"]);
  });

  it("defers adoption while busy, then adopts once idle", () => {
    const hook = mount({ items: ["a"] });
    act(() => hook.result.current.setState(["DRAGGING"]));
    const next = { items: ["z"] };
    hook.rerender({ source: next, busy: true });
    expect(hook.result.current.state).toEqual(["DRAGGING"]);
    expect(hook.result.current.generation).toBe(0);

    hook.rerender({ source: next, busy: false });
    expect(hook.result.current.state).toEqual(["Z"]);
    expect(hook.result.current.generation).toBe(1);
  });

  it("does not re-adopt when the source identity is unchanged", () => {
    const source = { items: ["a"] };
    const hook = mount(source);
    act(() => hook.result.current.setState(["LOCAL"]));
    hook.rerender({ source, busy: false });
    expect(hook.result.current.state).toEqual(["LOCAL"]);
  });
});

describe("planFlip", () => {
  const pt = (left: number, top: number) => ({ left, top });

  it("reports moved cards with the inverse delta, ignoring sub-pixel jitter", () => {
    const plan = planFlip(
      new Map([["a", pt(0, 0)], ["b", pt(10, 10)]]),
      new Map([["a", pt(300, 40)], ["b", pt(10.4, 10)]]),
    );
    expect(plan.moves).toEqual([{ id: "a", dx: -300, dy: -40 }]);
    expect(plan.entering).toEqual([]);
  });

  it("reports cards that only exist after as entering and ignores removed ones", () => {
    const plan = planFlip(new Map([["gone", pt(0, 0)]]), new Map([["new", pt(5, 5)]]));
    expect(plan.moves).toEqual([]);
    expect(plan.entering).toEqual(["new"]);
  });
});
