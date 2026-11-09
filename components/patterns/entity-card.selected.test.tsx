// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";

import { EntityCard } from "./entity-card";

afterEach(cleanup);

function card(props: Partial<React.ComponentProps<typeof EntityCard>> = {}) {
  render(<EntityCard title="Card title" {...props} />);
  return screen.getByText("Card title").closest("article")!;
}

describe("EntityCard selected (active) state", () => {
  it("exposes data-selected and aria-current when selected", () => {
    const el = card({ selected: true, interactive: true });
    expect(el).toHaveAttribute("data-selected", "true");
    expect(el).toHaveAttribute("aria-current", "true");
  });

  it("applies the accent border and 2px ring shadow when selected", () => {
    const el = card({ selected: true, interactive: true });
    expect(el.className).toContain("border-border-interactive!");
    expect(el.className).toContain("shadow-[0_0_0_2px_color-mix(in_oklab,var(--ring)_15%,transparent)]");
    expect(el.className).not.toContain("border-border-default");
  });

  it("keeps the ring on hover when selected instead of swapping it for the panel shadow", () => {
    const el = card({ selected: true, interactive: true });
    expect(el.className).toContain("hover:shadow-[0_0_0_2px_color-mix(in_oklab,var(--ring)_15%,transparent),var(--shadow-panel)]");
    expect(el.className).not.toContain("hover:border-border-strong");
  });

  it("has no active attributes or classes when not selected", () => {
    const el = card({ interactive: true });
    expect(el).not.toHaveAttribute("data-selected");
    expect(el).not.toHaveAttribute("aria-current");
    expect(el.className).not.toContain("border-border-interactive!");
    expect(el.className).not.toContain("color-mix");
    expect(el.className).toContain("border-border-default");
  });

  it("keeps the normal hover treatment on a non-selected interactive card", () => {
    const el = card({ interactive: true });
    expect(el.className).toContain("hover:border-border-strong");
    expect(el.className).toContain("hover:shadow-[var(--shadow-panel)]");
  });

  it("treats selected={false} the same as omitted", () => {
    const el = card({ selected: false });
    expect(el).not.toHaveAttribute("data-selected");
    expect(el).not.toHaveAttribute("aria-current");
  });

  it("lets a caller className still be appended (drag state classes survive selection)", () => {
    const el = card({ selected: true, interactive: true, className: "data-[dragging=true]:ring-2 data-[dragging=true]:shadow-[var(--shadow-panel)]" });
    expect(el.className).toContain("data-[dragging=true]:ring-2");
    expect(el.className).toContain("data-[dragging=true]:shadow-[var(--shadow-panel)]");
  });
});
