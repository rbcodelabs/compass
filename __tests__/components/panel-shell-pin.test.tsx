// @vitest-environment jsdom

/**
 * Component coverage for pinned detail panels
 * (components/panels/panel-shell.tsx + panel-resize-handle.tsx).
 *
 * Everything here is about the seams that Playwright cannot see cheaply: the
 * server-snapshot seeding that prevents an overlay flash, the split between
 * "live width" (a CSS custom property, written imperatively) and "committed
 * width" (React state + cookie), and the fact that a drag has to survive a
 * parent re-render.
 *
 * The nine entity panels are mocked to stubs. They fetch on mount and several
 * are large; none of them is under test here, and the panel body is passed
 * through verbatim in both modes, so a stub proves the same thing a real one
 * would. `DocEditor` is deliberately never rendered — TipTap needs
 * `Range.getClientRects`, which jsdom does not implement.
 */

import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import "@testing-library/jest-dom/vitest";

import {
  PANEL_WIDTH_DEFAULT,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
} from "@/lib/panel-pin";

// ── Mocks ────────────────────────────────────────────────────────────────────

const closePanel = vi.fn();
let panelState: { type: string; id: string } | null = { type: "objective", id: "obj-1" };

vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({
    panel: panelState,
    closePanel,
    openPanel: vi.fn(),
    orgSlug: "acme",
    workspaceSlug: "product",
    notifyEntityMutated: vi.fn(),
    subscribeEntityMutated: () => () => undefined,
  }),
}));

vi.mock("@/components/panels/objective-panel", () => ({
  ObjectivePanel: () => <div data-testid="objective-body">Objective body</div>,
}));
vi.mock("@/components/panels/key-result-panel", () => ({ KeyResultPanel: () => null }));
vi.mock("@/components/panels/opportunity-panel", () => ({ OpportunityPanel: () => null }));
vi.mock("@/components/panels/solution-panel", () => ({ SolutionPanel: () => null }));
vi.mock("@/components/panels/assumption-panel", () => ({ AssumptionPanel: () => null }));
vi.mock("@/components/panels/experiment-panel", () => ({ ExperimentPanel: () => null }));
vi.mock("@/components/panels/roadmap-item-panel", () => ({ RoadmapItemPanel: () => null }));
vi.mock("@/components/panels/feedback-panel", () => ({ FeedbackPanel: () => null }));
vi.mock("@/components/panels/discovery-rail-panel", () => ({ DiscoveryRailPanel: () => null }));
vi.mock("@/components/tasks/task-detail", () => ({ TaskDetail: () => null }));

import { PanelShell } from "@/components/panels/panel-shell";

// ── Harness ──────────────────────────────────────────────────────────────────

/** jsdom ships no matchMedia; useMediaQuery needs one to report a viewport. */
function setViewportAllowsPin(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

/**
 * jsdom implements none of the Pointer Capture API. Without these the handle's
 * pointerdown throws and no drag is possible.
 */
function installPointerCapture() {
  const captured = new Set<number>();
  Element.prototype.setPointerCapture = function setPointerCapture(id: number) {
    captured.add(id);
  };
  Element.prototype.releasePointerCapture = function releasePointerCapture(id: number) {
    captured.delete(id);
  };
  Element.prototype.hasPointerCapture = function hasPointerCapture(id: number) {
    return captured.has(id);
  };
}

/** Hold rAF callbacks so a test can prove coalescing and flush deliberately. */
let frames: FrameRequestCallback[] = [];
function flushFrames() {
  const pending = frames;
  frames = [];
  for (const callback of pending) callback(0);
}

function readPinCookie(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)compass_panel_detail=([^;]*)/);
  return match ? match[1] : null;
}

function clearPinCookie() {
  document.cookie = "compass_panel_detail=; Path=/; Max-Age=0";
}

const handle = () => screen.getByRole("separator", { name: "Resize panel" });
const aside = () => document.querySelector('[data-slot="pinned-panel"]') as HTMLElement | null;
const liveWidth = () => aside()?.style.getPropertyValue("--panel-w");

beforeEach(() => {
  panelState = { type: "objective", id: "obj-1" };
  closePanel.mockClear();
  clearPinCookie();
  installPointerCapture();
  setViewportAllowsPin(true);
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearPinCookie();
});

// ── Mode selection ───────────────────────────────────────────────────────────

describe("PanelShell mode selection", () => {
  it("renders the overlay Sheet when the cookie is absent (the load-bearing default)", () => {
    render(<PanelShell />);
    expect(aside()).toBeNull();
    // The Sheet is gated on `hydrated`, so nothing is open on first render —
    // which is exactly the pre-existing behaviour this must not change.
    expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull();
  });

  it("renders the pinned aside — not an overlay — when pinned on a wide viewport", () => {
    render(<PanelShell initialPin={{ pinned: true, width: PANEL_WIDTH_DEFAULT }} />);

    const panel = aside();
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute("data-panel-id", "detail");
    expect(document.querySelector('[data-slot="sheet-overlay"]')).toBeNull();
    expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull();
    // The body is the same tree in both modes.
    expect(screen.getByTestId("objective-body")).toBeInTheDocument();
    // A real heading, not just styled text.
    expect(screen.getByRole("heading", { name: "Objective" })).toBeInTheDocument();
  });

  it("demotes a pinned preference to overlay on a viewport below the gate", () => {
    setViewportAllowsPin(false);
    render(<PanelShell initialPin={{ pinned: true, width: PANEL_WIDTH_DEFAULT }} />);
    expect(aside()).toBeNull();
  });

  it("does not rewrite the cookie when the viewport suspends the preference", () => {
    setViewportAllowsPin(false);
    render(<PanelShell initialPin={{ pinned: true, width: 560 }} />);
    // The preference is the user's; the suspension is the environment's.
    // Rewriting here would silently lose the pin on a window resize.
    expect(readPinCookie()).toBeNull();
  });

  it("renders nothing at all in pinned mode when no panel is open", () => {
    panelState = null;
    const { container } = render(
      <PanelShell initialPin={{ pinned: true, width: PANEL_WIDTH_DEFAULT }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

// ── Hydration parity ─────────────────────────────────────────────────────────

describe("hydration parity", () => {
  it("server-renders the pinned aside for a pinned cookie even with no viewport information", () => {
    // This is the flash guard. On the server there is no matchMedia, so
    // useMediaQuery falls back to its serverSnapshot — which PanelShell seeds
    // with the pin preference precisely so the first painted frame is already
    // the pinned column. Report matches:false to prove the server path is
    // what decides, not the client query.
    setViewportAllowsPin(false);

    const html = renderToString(
      <PanelShell initialPin={{ pinned: true, width: PANEL_WIDTH_DEFAULT }} />,
    );

    expect(html).toContain('data-slot="pinned-panel"');
    expect(html).not.toContain('data-slot="sheet-overlay"');
    // And the CSS gate travels with it, so a wrong guess paints nothing
    // rather than painting a pinned panel on a viewport too narrow for one.
    expect(html).toContain("hidden");
    expect(html).toContain("lg:flex");
  });

  it("server-renders no overlay for the unpinned default", () => {
    const html = renderToString(<PanelShell />);
    expect(html).not.toContain('data-slot="sheet-overlay"');
    expect(html).not.toContain('data-slot="pinned-panel"');
  });
});

// ── Pin toggle ───────────────────────────────────────────────────────────────

describe("pin toggle", () => {
  it("writes a pinned cookie and swaps to the aside", async () => {
    render(<PanelShell />);
    // The overlay branch carries the toggle in its header — but only once the
    // pre-existing hydration gate has released and the Sheet has opened, so
    // this has to wait rather than query immediately.
    const toggle = await screen.findByRole("button", { name: "Pin panel" });
    fireEvent.click(toggle);
    expect(readPinCookie()).toMatch(/^1:\d+$/);
    expect(aside()).not.toBeNull();
  });

  it("writes an unpinned cookie and returns to the overlay branch", () => {
    render(<PanelShell initialPin={{ pinned: true, width: 520 }} />);
    fireEvent.click(screen.getByRole("button", { name: "Unpin panel" }));
    expect(readPinCookie()).toBe("0:520");
    expect(aside()).toBeNull();
  });

  it("uses an accessible name that cannot collide with the docs panel specs", () => {
    render(<PanelShell initialPin={{ pinned: true, width: PANEL_WIDTH_DEFAULT }} />);
    const name = screen.getByRole("button", { name: "Unpin panel" }).getAttribute("aria-label")!;
    for (const reserved of ["Comment", "Reply", "Resolve", "Restore", "Show resolved"]) {
      expect(name).not.toContain(reserved);
    }
  });
});

// ── Keyboard resize ──────────────────────────────────────────────────────────

describe("keyboard resize", () => {
  it("widens on ArrowLeft, updating aria-valuenow and the cookie together", () => {
    render(<PanelShell initialPin={{ pinned: true, width: PANEL_WIDTH_DEFAULT }} />);
    expect(handle()).toHaveAttribute("aria-valuenow", String(PANEL_WIDTH_DEFAULT));

    fireEvent.keyDown(handle(), { key: "ArrowLeft" });

    expect(handle()).toHaveAttribute("aria-valuenow", String(PANEL_WIDTH_DEFAULT + 16));
    expect(readPinCookie()).toBe(`1:${PANEL_WIDTH_DEFAULT + 16}`);
  });

  it("narrows on ArrowRight and takes a larger step with Shift", () => {
    render(<PanelShell initialPin={{ pinned: true, width: PANEL_WIDTH_DEFAULT }} />);
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    expect(handle()).toHaveAttribute("aria-valuenow", String(PANEL_WIDTH_DEFAULT - 16));

    fireEvent.keyDown(handle(), { key: "ArrowLeft", shiftKey: true });
    expect(handle()).toHaveAttribute("aria-valuenow", String(PANEL_WIDTH_DEFAULT - 16 + 64));
  });

  it("clamps at both bounds via Home and End", () => {
    render(<PanelShell initialPin={{ pinned: true, width: PANEL_WIDTH_DEFAULT }} />);

    fireEvent.keyDown(handle(), { key: "Home" });
    expect(handle()).toHaveAttribute("aria-valuenow", String(PANEL_WIDTH_MIN));
    // Already at the floor — another step must not go below it.
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    expect(handle()).toHaveAttribute("aria-valuenow", String(PANEL_WIDTH_MIN));

    fireEvent.keyDown(handle(), { key: "End" });
    expect(handle()).toHaveAttribute("aria-valuenow", String(PANEL_WIDTH_MAX));
    fireEvent.keyDown(handle(), { key: "ArrowLeft" });
    expect(handle()).toHaveAttribute("aria-valuenow", String(PANEL_WIDTH_MAX));
  });

  it("ignores keys that are not resize controls", () => {
    render(<PanelShell initialPin={{ pinned: true, width: PANEL_WIDTH_DEFAULT }} />);
    fireEvent.keyDown(handle(), { key: "a" });
    expect(readPinCookie()).toBeNull();
  });
});

// ── Pointer drag ─────────────────────────────────────────────────────────────

describe("pointer drag", () => {
  function startDrag(clientX = 1000) {
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientX });
  }

  it("writes the live width to the CSS property and does NOT touch the cookie until release", () => {
    render(<PanelShell initialPin={{ pinned: true, width: PANEL_WIDTH_DEFAULT }} />);

    startDrag(1000);
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 928 }); // 72px left → wider
    flushFrames();

    expect(liveWidth()).toBe(`${PANEL_WIDTH_DEFAULT + 72}px`);
    // The whole point: a drag must not write a cookie per frame.
    expect(readPinCookie()).toBeNull();
    // React state has not moved either, so the subtree has not re-rendered.
    expect(handle()).toHaveAttribute("aria-valuenow", String(PANEL_WIDTH_DEFAULT));

    fireEvent.pointerUp(handle(), { pointerId: 1, clientX: 928 });

    expect(readPinCookie()).toBe(`1:${PANEL_WIDTH_DEFAULT + 72}`);
    expect(handle()).toHaveAttribute("aria-valuenow", String(PANEL_WIDTH_DEFAULT + 72));
  });

  it("coalesces several moves within one frame into a single write", () => {
    render(<PanelShell initialPin={{ pinned: true, width: PANEL_WIDTH_DEFAULT }} />);

    startDrag(1000);
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 990 });
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 980 });
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 970 });

    expect(frames).toHaveLength(1); // three moves, one queued frame
    flushFrames();
    expect(liveWidth()).toBe(`${PANEL_WIDTH_DEFAULT + 30}px`); // the latest, not the first
  });

  it("survives a parent re-render mid-drag", () => {
    // React diffs style props against the previous props, not against the DOM,
    // so an unchanged `--panel-w` in props produces no write and the
    // imperative value stands. If that ever stops being true, the drag would
    // visibly snap back to the committed width on any parent render.
    function Host() {
      const [, forceRender] = React.useReducer((n: number) => n + 1, 0);
      return (
        <>
          <button onClick={forceRender}>rerender</button>
          <PanelShell initialPin={{ pinned: true, width: PANEL_WIDTH_DEFAULT }} />
        </>
      );
    }
    render(<Host />);

    startDrag(1000);
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 940 });
    flushFrames();
    expect(liveWidth()).toBe(`${PANEL_WIDTH_DEFAULT + 60}px`);

    fireEvent.click(screen.getByRole("button", { name: "rerender" }));

    expect(liveWidth()).toBe(`${PANEL_WIDTH_DEFAULT + 60}px`);

    // …and the drag is still live: another move keeps tracking.
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 920 });
    flushFrames();
    expect(liveWidth()).toBe(`${PANEL_WIDTH_DEFAULT + 80}px`);

    fireEvent.pointerUp(handle(), { pointerId: 1, clientX: 920 });
    expect(readPinCookie()).toBe(`1:${PANEL_WIDTH_DEFAULT + 80}`);
  });

  it("clamps the gesture itself so the panel cannot outrun the pointer", () => {
    render(<PanelShell initialPin={{ pinned: true, width: PANEL_WIDTH_DEFAULT }} />);

    startDrag(1000);
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: -5000 }); // far past the max
    flushFrames();
    expect(liveWidth()).toBe(`${PANEL_WIDTH_MAX}px`);

    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 5000 }); // far past the min
    flushFrames();
    expect(liveWidth()).toBe(`${PANEL_WIDTH_MIN}px`);
  });

  it("bounds the gesture by the room main content actually has", () => {
    // resolveMaxWidth measures the real main-content element, located by its
    // data-slot, so the bound reflects the live layout rather than a constant.
    render(
      <div>
        <div data-slot="sidebar-inset" data-testid="main" />
        <PanelShell initialPin={{ pinned: true, width: PANEL_WIDTH_DEFAULT }} />
      </div>,
    );
    const main = screen.getByTestId("main");
    // 600px of main content leaves 120px of slack above the 480px floor.
    main.getBoundingClientRect = () => ({ width: 600, height: 0, top: 0, left: 0, right: 600, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    startDrag(1000);
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: -5000 });
    flushFrames();

    expect(liveWidth()).toBe(`${PANEL_WIDTH_DEFAULT + 120}px`);
  });

  it("reverts to the starting width and commits nothing when the gesture is cancelled", () => {
    render(<PanelShell initialPin={{ pinned: true, width: PANEL_WIDTH_DEFAULT }} />);

    startDrag(1000);
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 900 });
    flushFrames();
    expect(liveWidth()).toBe(`${PANEL_WIDTH_DEFAULT + 100}px`);

    fireEvent.pointerCancel(handle(), { pointerId: 1 });

    expect(liveWidth()).toBe(`${PANEL_WIDTH_DEFAULT}px`);
    expect(readPinCookie()).toBeNull();
  });

  it("releases the document-wide cursor lock on release", () => {
    render(<PanelShell initialPin={{ pinned: true, width: PANEL_WIDTH_DEFAULT }} />);

    startDrag(1000);
    expect(document.documentElement.dataset.panelResizing).toBe("");

    fireEvent.pointerUp(handle(), { pointerId: 1, clientX: 1000 });
    expect(document.documentElement.dataset.panelResizing).toBeUndefined();
  });

  it("ignores a non-primary button", () => {
    render(<PanelShell initialPin={{ pinned: true, width: PANEL_WIDTH_DEFAULT }} />);
    fireEvent.pointerDown(handle(), { button: 2, pointerId: 1, clientX: 1000 });
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 900 });
    flushFrames();
    expect(liveWidth()).toBe(`${PANEL_WIDTH_DEFAULT}px`);
  });
});

// ── Escape scoping ───────────────────────────────────────────────────────────

describe("Escape in pinned mode", () => {
  it("closes the panel when Escape originates inside the aside", () => {
    render(<PanelShell initialPin={{ pinned: true, width: PANEL_WIDTH_DEFAULT }} />);
    fireEvent.keyDown(screen.getByTestId("objective-body"), { key: "Escape" });
    expect(closePanel).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape pressed outside the aside", () => {
    // A pinned panel is not a modal and traps nothing, so a user typing Escape
    // in a main-content field must not lose the column they docked.
    render(
      <div>
        <input data-testid="outside" />
        <PanelShell initialPin={{ pinned: true, width: PANEL_WIDTH_DEFAULT }} />
      </div>,
    );
    fireEvent.keyDown(screen.getByTestId("outside"), { key: "Escape" });
    expect(closePanel).not.toHaveBeenCalled();
  });

  it("closes from the header close button", () => {
    render(<PanelShell initialPin={{ pinned: true, width: PANEL_WIDTH_DEFAULT }} />);
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(closePanel).toHaveBeenCalledTimes(1);
  });
});
