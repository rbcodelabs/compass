// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";

import { Board } from "@/components/patterns/board";

afterEach(cleanup);

function dimension(el: HTMLElement, name: "scrollWidth" | "clientWidth" | "scrollHeight" | "clientHeight", value: number) {
  Object.defineProperty(el, name, { configurable: true, value });
}

function renderWideBoard() {
  const utils = render(
    <Board label="Roadmap board">
      <section data-testid="column">
        <div data-testid="card">card</div>
      </section>
    </Board>
  );
  const board = utils.getByRole("region", { name: "Roadmap board" });
  dimension(board, "scrollWidth", 1200);
  dimension(board, "clientWidth", 400);
  return { board, column: utils.getByTestId("column"), card: utils.getByTestId("card") };
}

describe("Board wheel scrolling", () => {
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
