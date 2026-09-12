// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { PageHeader } from "@/components/patterns/page-header";
import { Board, BoardColumn } from "@/components/patterns/board";

afterEach(cleanup);

describe("PageHeader sticky", () => {
  it("does not stick by default", () => {
    const { container } = render(<PageHeader title="Roadmap" />);
    const header = container.querySelector("header");
    expect(header).not.toHaveClass("sticky");
  });

  it("sticks to the top of its scroll container when sticky is set", () => {
    const { container } = render(<PageHeader title="Roadmap" sticky />);
    const header = container.querySelector("header");
    expect(header).toHaveClass("sticky");
    expect(header).toHaveClass("top-0");
    // Needs an opaque background so scrolled content doesn't show through.
    expect(header?.className).toMatch(/bg-surface-app/);
  });
});

describe("BoardColumn sticky header + independently scrolling body", () => {
  it("keeps the column header pinned within its own scroll region at md+, leaving mobile untouched", () => {
    const { container } = render(
      <Board>
        <BoardColumn title="NOW" bodyId="col-body">
          <div>card 1</div>
        </BoardColumn>
      </Board>
    );

    const header = container.querySelector("header");
    expect(header).toHaveClass("md:sticky");
    expect(header).toHaveClass("md:top-0");
    // Should NOT be sticky below the md breakpoint — mobile keeps whole-page scroll.
    expect(header).not.toHaveClass("sticky");

    const body = container.querySelector("#col-body");
    expect(body).toHaveClass("md:overflow-y-auto");
    expect(body?.className).toMatch(/md:max-h-/);
  });

  // A column nested inside a lane (the Discovery swimlane board) must NOT use
  // any of the above. `sticky` resolves against the nearest scrolling
  // ancestor, which when nested is the lane/board rather than this column — so
  // a sticky header detaches from its own column and rides up over the lane
  // header above it, and the header's negative-margin background bleed paints
  // outside the lane's rounded border. Both were visible bugs on the swimlane
  // board before `nested` existed.
  it("drops the sticky header, the margin bleed, and its own scroll region when nested", () => {
    const { container } = render(
      <Board>
        <BoardColumn title="Idea" bodyId="nested-body" nested>
          <div>card 1</div>
        </BoardColumn>
      </Board>
    );

    const header = container.querySelector("header");
    expect(header).not.toHaveClass("md:sticky");
    expect(header).not.toHaveClass("sticky");
    expect(header).not.toHaveClass("md:top-0");
    expect(header).not.toHaveClass("md:z-10");
    // No negative-margin background bleed past the column's padding box.
    expect(header?.className).not.toMatch(/-mx-3|-mt-3/);

    // The lane owns scrolling, so a nested column caps nothing and scrolls
    // nothing of its own.
    const body = container.querySelector("#nested-body");
    expect(body).not.toHaveClass("md:overflow-y-auto");
    expect(body?.className).not.toMatch(/max-h-/);
  });
});
