// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { createElement, type ReactNode } from "react";
import { createBoardLayout, useBoardLayoutStore, type BoardLayoutConfig } from "@/components/patterns/use-board-layout-store";
import { pinColumn, togglePinColumn } from "@/lib/board-layout";

const A: BoardLayoutConfig = {
  columnIds: ["a1", "a2", "a3"],
  defaults: { pinned: ["a3"], active: "a3", dockCollapsed: true },
  storageKey: (s) => `test:board-a:${s}`,
};
const B: BoardLayoutConfig = {
  columnIds: ["b1", "b2"],
  storageKey: (s) => `test:board-b:${s}`,
};

type Opts = { scopeId?: string; sourceKey?: string; initial?: unknown; mirrorLocal?: boolean };
const opts = (o: Opts = {}) => ({ scopeId: "ws", sourceKey: "none", initial: undefined, mirrorLocal: true, ...o });

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe("useBoardLayoutStore", () => {
  it("starts from the defaults", () => {
    const { result } = renderHook(() => useBoardLayoutStore(A, opts()));
    expect(result.current.layout.pinnedColumnIds).toEqual(["a3"]);
    expect(result.current.stored).toBeUndefined();
  });

  it("mirrors changes to localStorage when there is no saved view, and restores them on the next mount", () => {
    const first = renderHook(() => useBoardLayoutStore(A, opts()));
    act(() => first.result.current.update((l) => pinColumn(l, "a1")));
    expect(JSON.parse(window.localStorage.getItem("test:board-a:ws")!).pinnedColumnIds).toContain("a1");
    first.unmount();
    const second = renderHook(() => useBoardLayoutStore(A, opts()));
    expect(second.result.current.layout.pinnedColumnIds).toContain("a1");
  });

  it("removes the stored value when the layout returns to the default", () => {
    const { result } = renderHook(() => useBoardLayoutStore(B, opts()));
    act(() => result.current.update((l) => togglePinColumn(l, "b1")));
    expect(window.localStorage.getItem("test:board-b:ws")).not.toBeNull();
    act(() => result.current.update((l) => togglePinColumn(l, "b1")));
    expect(window.localStorage.getItem("test:board-b:ws")).toBeNull();
  });

  it("does not touch localStorage when a saved view is selected, and ignores what is there", () => {
    window.localStorage.setItem("test:board-a:ws", JSON.stringify({ columnOrder: ["a1", "a2", "a3"], pinnedColumnIds: ["a1"] }));
    const { result } = renderHook(() => useBoardLayoutStore(A, opts({ sourceKey: "v1:1", mirrorLocal: false, initial: undefined })));
    expect(result.current.layout.pinnedColumnIds).toEqual(["a3"]);
    const before = window.localStorage.getItem("test:board-a:ws");
    act(() => result.current.update((l) => pinColumn(l, "a2")));
    expect(result.current.layout.pinnedColumnIds).toContain("a2");
    expect(window.localStorage.getItem("test:board-a:ws")).toBe(before);
  });

  it("resets to the saved view's layout when sourceKey changes, but keeps edits while it stays the same", () => {
    const saved = { columnOrder: ["a2", "a1", "a3"], pinnedColumnIds: ["a2"] };
    const { result, rerender } = renderHook((p: Opts) => useBoardLayoutStore(A, opts(p)), {
      initialProps: { sourceKey: "v1:1", mirrorLocal: false, initial: saved } as Opts,
    });
    expect(result.current.layout.pinnedColumnIds).toEqual(["a2"]);
    act(() => result.current.update((l) => pinColumn(l, "a1")));
    expect(result.current.layout.pinnedColumnIds).toContain("a1");
    rerender({ sourceKey: "v1:1", mirrorLocal: false, initial: saved });
    expect(result.current.layout.pinnedColumnIds).toContain("a1");
    rerender({ sourceKey: "v1:2", mirrorLocal: false, initial: saved });
    expect(result.current.layout.pinnedColumnIds).toEqual(["a2"]);
    rerender({ sourceKey: "v2:1", mirrorLocal: false, initial: undefined });
    expect(result.current.layout.pinnedColumnIds).toEqual(["a3"]);
  });

  it("is hydration-safe: the server render and first client render use the defaults, then localStorage is applied in an effect", () => {
    window.localStorage.setItem("test:board-a:ws", JSON.stringify({ columnOrder: ["a1", "a2", "a3"], pinnedColumnIds: ["a1"] }));
    const seen: string[][] = [];
    function Probe() {
      const { layout } = useBoardLayoutStore(A, opts());
      seen.push(layout.pinnedColumnIds);
      return createElement("span", null, layout.pinnedColumnIds.join(","));
    }
    // Server render has no window effects: only the defaults.
    expect(renderToString(createElement(Probe))).toContain("a3");
    seen.length = 0;
    const { container } = render(createElement(Probe));
    expect(seen[0]).toEqual(["a3"]); // first render equals the server's
    expect(container.textContent).toBe("a1"); // then the stored layout
  });

  it("tolerates corrupt or foreign storage", () => {
    for (const raw of ["{not json", JSON.stringify({ columnOrder: 5, pinnedColumnIds: "x" }), JSON.stringify("hi"), "null"]) {
      window.localStorage.setItem("test:board-a:ws", raw);
      const { result, unmount } = renderHook(() => useBoardLayoutStore(A, opts()));
      expect(result.current.layout.pinnedColumnIds).toEqual(["a3"]);
      unmount();
    }
  });

  it("tolerates blocked storage", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const { result } = renderHook(() => useBoardLayoutStore(A, opts()));
    act(() => result.current.update((l) => pinColumn(l, "a1")));
    expect(result.current.layout.pinnedColumnIds).toContain("a1");
    get.mockRestore();
    set.mockRestore();
  });

  it("drops stale ids from storage", () => {
    window.localStorage.setItem("test:board-a:ws", JSON.stringify({ columnOrder: ["a3", "gone", "a1"], pinnedColumnIds: ["gone", "a1"] }));
    const { result } = renderHook(() => useBoardLayoutStore(A, opts()));
    expect(result.current.layout.columnOrder).toEqual(["a3", "a1", "a2"]);
    expect(result.current.layout.pinnedColumnIds).toEqual(["a1"]);
  });

  it("isolates scopes by storage key", () => {
    const one = renderHook(() => useBoardLayoutStore(A, opts({ scopeId: "ws-1" })));
    act(() => one.result.current.update((l) => pinColumn(l, "a1")));
    expect(window.localStorage.getItem("test:board-a:ws-2")).toBeNull();
    const two = renderHook(() => useBoardLayoutStore(A, opts({ scopeId: "ws-2" })));
    expect(two.result.current.layout.pinnedColumnIds).toEqual(["a3"]);
  });

  it("switching scope reads the new scope's storage", () => {
    window.localStorage.setItem("test:board-a:ws-2", JSON.stringify({ columnOrder: ["a1", "a2", "a3"], pinnedColumnIds: ["a2"] }));
    const { result, rerender } = renderHook((p: Opts) => useBoardLayoutStore(A, opts(p)), { initialProps: { scopeId: "ws-1" } });
    expect(result.current.layout.pinnedColumnIds).toEqual(["a3"]);
    rerender({ scopeId: "ws-2" });
    expect(result.current.layout.pinnedColumnIds).toEqual(["a2"]);
  });

  it("a no-op transition changes nothing and writes nothing", () => {
    const { result } = renderHook(() => useBoardLayoutStore(A, opts()));
    act(() => result.current.update((l) => l));
    expect(window.localStorage.getItem("test:board-a:ws")).toBeNull();
  });
});

describe("createBoardLayout", () => {
  it("two boards with different configs do not interfere", () => {
    const boardA = createBoardLayout(A);
    const boardB = createBoardLayout(B);
    const wrapper = ({ children }: { children: ReactNode }) =>
      <boardA.Provider scopeId="ws" savedView={null}><boardB.Provider scopeId="ws" savedView={null}>{children}</boardB.Provider></boardA.Provider>;
    const { result } = renderHook(() => ({ a: boardA.useContextController(), b: boardB.useContextController() }), { wrapper });
    act(() => result.current.a!.update((l) => pinColumn(l, "a1")));
    expect(result.current.a!.layout.pinnedColumnIds).toContain("a1");
    expect(result.current.b!.layout.pinnedColumnIds).toEqual([]);
    expect(result.current.b!.layout.columnOrder).toEqual(["b1", "b2"]);
    act(() => result.current.b!.update((l) => pinColumn(l, "b2")));
    expect(result.current.a!.layout.pinnedColumnIds).not.toContain("b2");
    expect(window.localStorage.getItem("test:board-a:ws")).toContain("a1");
    expect(window.localStorage.getItem("test:board-b:ws")).toContain("b2");
  });

  it("the context consumer is null outside a provider, and the board hook falls back to a standalone localStorage-mirrored store", () => {
    const board = createBoardLayout(A);
    const { result } = renderHook(() => ({ ctx: board.useContextController(), own: board.useBoardLayout("ws") }));
    expect(result.current.ctx).toBeNull();
    act(() => result.current.own.update((l) => pinColumn(l, "a2")));
    expect(JSON.parse(window.localStorage.getItem("test:board-a:ws")!).pinnedColumnIds).toContain("a2");
  });

  it("the board hook uses the provider's store (and a saved view never mirrors)", () => {
    const board = createBoardLayout(A);
    const view = { id: "v", version: "1", columnLayout: undefined };
    const wrapper = ({ children }: { children: ReactNode }) => <board.Provider scopeId="ws" savedView={view}>{children}</board.Provider>;
    const { result } = renderHook(() => ({ ctx: board.useContextController(), own: board.useBoardLayout("ws") }), { wrapper });
    expect(result.current.own).toBe(result.current.ctx);
    act(() => result.current.own.update((l) => pinColumn(l, "a1")));
    expect(result.current.ctx!.layout.pinnedColumnIds).toContain("a1");
    expect(window.localStorage.getItem("test:board-a:ws")).toBeNull();
  });
});
