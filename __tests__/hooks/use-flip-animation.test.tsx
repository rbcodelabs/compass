// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";

import { useFlipAnimation } from "@/hooks/use-flip-animation";

let animate: ReturnType<typeof vi.fn>;
let captureRef: (() => void) | null = null;

function Board({ ids, generation }: { ids: string[]; generation: number }) {
  const { containerRef, capture } = useFlipAnimation(generation);
  useEffect(() => {
    captureRef = capture;
  });
  return (
    <div ref={containerRef}>
      {ids.map((id) => (
        <div key={id} data-flip-id={id}>
          card {id}
        </div>
      ))}
    </div>
  );
}

beforeEach(() => {
  animate = vi.fn(() => ({}) as Animation);
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.querySelectorAll("[aria-hidden='true'][style*='fixed']").forEach((el) => el.remove());
});

describe("useFlipAnimation", () => {
  it("animates nothing when the generation changes without a captured snapshot", () => {
    const view = render(<Board ids={["a"]} generation={0} />);
    view.rerender(<Board ids={["a", "b"]} generation={1} />);
    expect(animate).not.toHaveBeenCalled();
  });

  it("fades in a new card and fades out a ghost clone of a removed one", () => {
    const view = render(<Board ids={["a", "b"]} generation={0} />);
    act(() => captureRef?.());

    view.rerender(<Board ids={["a", "c"]} generation={1} />);

    // "c" entering is animated in place; "b" is gone, so its clone is fixed on <body>.
    expect(animate).toHaveBeenCalled();
    const ghost = document.body.querySelector<HTMLElement>("[aria-hidden='true']");
    expect(ghost?.textContent).toContain("card b");
    expect(ghost?.style.position).toBe("fixed");
    expect(ghost?.hasAttribute("data-flip-id")).toBe(false);
  });

  it("does nothing under prefers-reduced-motion", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const view = render(<Board ids={["a", "b"]} generation={0} />);
    act(() => captureRef?.());
    view.rerender(<Board ids={["a"]} generation={1} />);
    expect(animate).not.toHaveBeenCalled();
    expect(document.body.querySelector("[aria-hidden='true'][style*='fixed']")).toBeNull();
  });
});
