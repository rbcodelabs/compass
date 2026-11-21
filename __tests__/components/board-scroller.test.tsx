// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";

import { Board } from "@/components/patterns/board";

let desktop = true;
beforeEach(() => {
  desktop = true;
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: desktop })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function dimension(el: HTMLElement, name: "scrollWidth" | "clientWidth" | "scrollHeight" | "clientHeight", value: number) {
  Object.defineProperty(el, name, { configurable: true, value });
}

function renderWideBoard() {
  const utils = render(
    <Board label="Roadmap board">
      <section data-testid="column">
        <div data-testid="card">card</div>
        <svg data-testid="icon"><path data-testid="path" d="M0 0h10v10z" /></svg>
      </section>
    </Board>
  );
  const board = utils.getByRole("region", { name: "Roadmap board" });
  dimension(board, "scrollWidth", 1200);
  dimension(board, "clientWidth", 400);
  return { board, column: utils.getByTestId("column"), card: utils.getByTestId("card"), icon: utils.getByTestId("icon"), path: utils.getByTestId("path") };
}

describe("Board wheel scrolling", () => {
  it.each(["icon", "path"] as const)("preserves nested vertical scrolling from an SVG %s target", (target) => {
    const elements = renderWideBoard();
    elements.column.style.overflowY = "auto";
    dimension(elements.column, "scrollHeight", 900);
    dimension(elements.column, "clientHeight", 300);
    expect(fireEvent.wheel(elements[target], { deltaY: 100 })).toBe(true);
    expect(elements.board.scrollLeft).toBe(0);
  });

  it.each(["card", "icon", "path"] as const)("preserves nested horizontal scrolling from a %s target", (target) => {
    const elements = renderWideBoard();
    elements.column.style.overflowX = "auto";
    dimension(elements.column, "scrollWidth", 900);
    dimension(elements.column, "clientWidth", 300);
    expect(fireEvent.wheel(elements[target], { deltaY: 100 })).toBe(true);
    expect(elements.board.scrollLeft).toBe(0);
  });

  it.each(["auto", "scroll"])("preserves Board-owned vertical overflow (%s)", (overflowY) => {
    const { board, card } = renderWideBoard();
    board.style.overflowY = overflowY;
    dimension(board, "scrollHeight", 900);
    dimension(board, "clientHeight", 300);
    expect(fireEvent.wheel(card, { deltaY: 100 })).toBe(true);
    expect(board.scrollLeft).toBe(0);
    expect(fireEvent.wheel(board, { deltaY: 100 })).toBe(true);
    expect(board.scrollLeft).toBe(0);
  });

  it("retains native vertical wheel navigation below the desktop breakpoint", () => {
    desktop = false;
    const { board, card } = renderWideBoard();
    expect(fireEvent.wheel(card, { deltaY: 100 })).toBe(true);
    expect(board.scrollLeft).toBe(0);
  });

  it("rechecks the viewport after resizing between desktop and mobile", () => {
    const { board, card } = renderWideBoard();
    expect(fireEvent.wheel(card, { deltaY: 100 })).toBe(false);
    desktop = false;
    expect(fireEvent.wheel(card, { deltaY: 100 })).toBe(true);
    expect(board.scrollLeft).toBe(100);
    desktop = true;
    expect(fireEvent.wheel(card, { deltaY: -50 })).toBe(false);
    expect(board.scrollLeft).toBe(50);
  });

  it.each([0, 600])("keeps a nested vertical scrollport's wheel at scrollTop %i", (scrollTop) => {
    const { board, column, path } = renderWideBoard();
    column.style.overflowY = "auto";
    dimension(column, "scrollHeight", 900);
    dimension(column, "clientHeight", 300);
    column.scrollTop = scrollTop;
    expect(fireEvent.wheel(path, { deltaY: scrollTop === 0 ? -100 : 100 })).toBe(true);
    expect(board.scrollLeft).toBe(0);
  });

  it("does not treat clipped Board content as a native vertical scrollport", () => {
    const { board, card } = renderWideBoard();
    board.style.overflowY = "hidden";
    dimension(board, "scrollHeight", 900);
    dimension(board, "clientHeight", 300);
    expect(fireEvent.wheel(card, { deltaY: 100 })).toBe(false);
    expect(board.scrollLeft).toBe(100);
  });

  it("does not intercept a wheel event already consumed by a child", () => {
    const { board, card } = renderWideBoard();
    card.addEventListener("wheel", (event) => event.preventDefault());
    fireEvent.wheel(card, { deltaY: 100 });
    expect(board.scrollLeft).toBe(0);
  });

  it("normalises page-mode deltas using the Board width", () => {
    const { board, card } = renderWideBoard();
    expect(fireEvent.wheel(card, { deltaY: 1, deltaMode: 2 })).toBe(false);
    expect(board.scrollLeft).toBe(400);
  });

  it("keeps equal-axis and zero-delta gestures native", () => {
    const { board, card } = renderWideBoard();
    expect(fireEvent.wheel(card, { deltaX: 40, deltaY: 40 })).toBe(true);
    expect(fireEvent.wheel(card, { deltaY: 0 })).toBe(true);
    expect(board.scrollLeft).toBe(0);
  });

  it("turns a vertical wheel turn into sideways scroll and cancels the default", () => {
    const { board, card } = renderWideBoard();
    const notCancelled = fireEvent.wheel(card, { deltaY: 100 });
    expect(board.scrollLeft).toBe(100);
    expect(notCancelled).toBe(false);
  });

  it("leaves mainly-sideways, Shift and Ctrl wheel gestures to the browser", () => {
    const { board, card } = renderWideBoard();
    fireEvent.wheel(card, { deltaX: 80, deltaY: 10 });
    fireEvent.wheel(card, { deltaY: 100, shiftKey: true });
    fireEvent.wheel(card, { deltaY: 100, ctrlKey: true });
    expect(board.scrollLeft).toBe(0);
  });

  it("does nothing when the board has no horizontal overflow", () => {
    const { board, card } = renderWideBoard();
    dimension(board, "scrollWidth", 400);
    const notCancelled = fireEvent.wheel(card, { deltaY: 100 });
    expect(board.scrollLeft).toBe(0);
    expect(notCancelled).toBe(true);
  });

  it("lets a column that scrolls vertically keep the wheel", () => {
    const { board, column, card } = renderWideBoard();
    column.style.overflowY = "auto";
    dimension(column, "scrollHeight", 900);
    dimension(column, "clientHeight", 300);
    fireEvent.wheel(card, { deltaY: 100 });
    expect(board.scrollLeft).toBe(0);
  });

  it("normalises line-mode wheel deltas to pixels", () => {
    const { board, card } = renderWideBoard();
    fireEvent.wheel(card, { deltaY: 3, deltaMode: 1 });
    expect(board.scrollLeft).toBe(120);
  });
});

describe("Roadmap drag precedence", () => {
  function setup(active: boolean) {
    const view = (dragActive: boolean) => (
      <Board label="Roadmap" wheelSnapControl dragActive={dragActive}>Card</Board>
    );
    const rendered = render(view(active));
    const board = rendered.getByRole("region");
    dimension(board, "scrollWidth", 1200);
    dimension(board, "clientWidth", 400);
    return { board, setActive: (next: boolean) => rendered.rerender(view(next)) };
  }

  it("ends an ongoing wheel burst immediately when dragging starts", () => {
    const { board, setActive } = setup(false);
    fireEvent.wheel(board, { deltaY: 40 });
    expect(board.hasAttribute("data-wheel-panning")).toBe(true);
    setActive(true);
    expect(board.hasAttribute("data-wheel-panning")).toBe(false);
    setActive(false);
    expect(board.hasAttribute("data-wheel-panning")).toBe(false);
  });

  it("keeps drag snap and offset when a wheel gesture follows drag activation", () => {
    const { board, setActive } = setup(true);
    fireEvent.wheel(board, { deltaY: 40 });
    expect(board.scrollLeft).toBe(0);
    expect(board.hasAttribute("data-wheel-panning")).toBe(false);
    setActive(false);
    fireEvent.wheel(board, { deltaY: 40 });
    expect(board.scrollLeft).toBe(40);
  });
});
