// @vitest-environment jsdom

/**
 * Component coverage for the agent rail
 * (components/agent/agent-rail.tsx + agent-rail-context.tsx).
 *
 * The rail's whole value is in what it *doesn't* do — navigate, remount, or
 * refetch a transcript that is already on screen — and none of that is visible
 * to a screenshot. So the assertions here are about those seams:
 *
 *  - docked column vs floating overlay, chosen from measured layout rather than
 *    a media query (unlike the detail panel, whose `lg:` gate it cannot reuse:
 *    a 1440px viewport has room for the rail only when no detail panel is open);
 *  - that the rail never calls `router.push` on its own except for the explicit
 *    "expand to full page" action;
 *  - that a conversation created *inside* the rail is adopted without refetching
 *    its messages, which is what protects the just-streamed transcript.
 *
 * `AgentChat` is mocked. It is covered by its own specs, it opens an SSE stream
 * on submit, and the rail's contract with it is entirely in props — which a stub
 * can report precisely. The stub also exposes a button that fires
 * `onConversationCreated`, standing in for "turn one of a new chat finished".
 */

import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { PANEL_WIDTH_DEFAULT, parsePanelPin } from "@/lib/panel-pin";

// ── Mocks ────────────────────────────────────────────────────────────────────

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));

let panelState: { type: string; id: string } | null = null;
vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({
    panel: panelState,
    closePanel: vi.fn(),
    openPanel: vi.fn(),
    orgSlug: "acme",
    workspaceSlug: "product",
    notifyEntityMutated: vi.fn(),
    subscribeEntityMutated: () => () => undefined,
  }),
}));

/** Props the stub saw on its most recent render. */
let lastChatProps: Record<string, unknown> = {};
/** How many times the stub has mounted — proof the rail does not remount it. */
let chatMounts = 0;

vi.mock("@/components/agent/agent-chat", () => ({
  AgentChat: (props: Record<string, unknown>) => {
    lastChatProps = props;
    React.useEffect(() => {
      chatMounts += 1;
    }, []);
    return (
      <div data-testid="agent-chat">
        <button
          type="button"
          onClick={() =>
            (props.onConversationCreated as ((id: string) => void) | undefined)?.("conv-new")
          }
        >
          fire-created
        </button>
      </div>
    );
  },
}));

import { AgentRail } from "@/components/agent/agent-rail";
import { AgentRailProvider } from "@/components/agent/agent-rail-context";

// ── Harness ──────────────────────────────────────────────────────────────────

/**
 * The DOM landmarks `measure()` walks. Deliberately the real selectors rather
 * than a prop: the rail reads the *live* sidebar gap so a nav collapse re-clamps
 * it, and a test that injected widths directly would not exercise that path.
 */
function Harness({
  children,
  withDetailPanel = false,
}: {
  children: React.ReactNode;
  withDetailPanel?: boolean;
}) {
  return (
    <div data-slot="sidebar-wrapper">
      <div data-slot="sidebar-gap" />
      {children}
      {withDetailPanel && <div data-slot="pinned-panel" />}
    </div>
  );
}

const originalRect = Element.prototype.getBoundingClientRect;

/** jsdom reports every box as 0×0, so the measured layout has to be stubbed. */
function stubLayout({
  wrapper,
  nav,
  detail = 0,
}: {
  wrapper: number;
  nav: number;
  detail?: number;
}) {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
    const slot = (this as HTMLElement).dataset?.slot;
    const width =
      slot === "sidebar-wrapper"
        ? wrapper
        : slot === "sidebar-gap"
          ? nav
          : slot === "pinned-panel"
            ? detail
            : 0;
    return {
      width,
      height: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
}

function renderRail({
  pinned = true,
  width = PANEL_WIDTH_DEFAULT,
  withDetailPanel = false,
}: { pinned?: boolean; width?: number; withDetailPanel?: boolean } = {}) {
  return render(
    <Harness withDetailPanel={withDetailPanel}>
      <AgentRailProvider initialPin={{ pinned, width }}>
        <AgentRail workspaceId="ws-1" basePath="/acme/product" userInitials="RB" />
      </AgentRailProvider>
    </Harness>,
  );
}

const rail = () => document.querySelector('[data-slot="agent-rail"]') as HTMLElement | null;
const railCookie = () => {
  const match = document.cookie.match(/(?:^|;\s*)compass_panel_agent=([^;]*)/);
  return match ? decodeURIComponent(match[1]!) : null;
};

let fetchCalls: string[] = [];

/** Pick a thread out of the header's conversation switcher. */
async function selectThread(title: string) {
  fireEvent.click(screen.getByRole("button", { name: "Switch conversation" }));
  fireEvent.click(await screen.findByText(title));
}

beforeEach(() => {
  push.mockClear();
  panelState = null;
  lastChatProps = {};
  chatMounts = 0;
  fetchCalls = [];
  document.cookie = "compass_panel_agent=; Path=/; Max-Age=0";
  // Wide enough to dock unless a test says otherwise.
  stubLayout({ wrapper: 1920, nav: 220 });
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input);
    fetchCalls.push(url);
    const body = url.includes("/messages")
      ? { messages: [{ id: `m-${url.split("/")[4]}`, role: "assistant", content: "hi" }] }
      : {
          conversations: [
            { id: "conv-1", title: "First chat" },
            { id: "conv-new", title: "Second chat" },
          ],
        };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Element.prototype.getBoundingClientRect = originalRect;
  document.cookie = "compass_panel_agent=; Path=/; Max-Age=0";
});

// ── Open state ───────────────────────────────────────────────────────────────

describe("AgentRail open state", () => {
  it("renders nothing when the cookie says closed — the default for every new user", () => {
    renderRail({ pinned: false });
    expect(rail()).toBeNull();
    expect(screen.queryByTestId("agent-chat")).not.toBeInTheDocument();
    // Nothing is fetched for a rail nobody opened.
    expect(fetchCalls).toEqual([]);
  });

  it("is already open on first render when the cookie says so (no post-hydration pop-in)", () => {
    renderRail();
    expect(rail()).not.toBeNull();
    expect(screen.getByTestId("agent-chat")).toBeInTheDocument();
  });

  it("closes on Escape and records the preference in the cookie", () => {
    renderRail();
    fireEvent.keyDown(rail() as HTMLElement, { key: "Escape" });
    expect(rail()).toBeNull();
    // Closed, but the chosen width is kept — reopening should not reset it.
    expect(parsePanelPin(railCookie())).toEqual({ pinned: false, width: PANEL_WIDTH_DEFAULT });
  });
});

// ── Docked vs overlay ────────────────────────────────────────────────────────

describe("space-driven mode selection", () => {
  it("docks as a column when the measured leftover clears the minimum", () => {
    // 1920 - 220 nav - 480 main floor = 1220 available.
    renderRail();
    const aside = rail() as HTMLElement;
    expect(aside).toHaveAttribute("data-mode", "docked");
    expect(aside.className).toContain("agent-rail-surface");
    // The measured bound is handed to CSS, which clamps against it.
    expect(aside.style.getPropertyValue("--agent-rail-max")).toBe("1220px");
    // Resizing is only meaningful against main content.
    expect(screen.getByRole("separator", { name: "Resize panel" })).toBeInTheDocument();
  });

  it("demotes to a floating overlay on a 1440px viewport with a detail panel open", () => {
    // The case that chose this design: 1440 - 220 nav - 448 detail - 480 main
    // floor = 292, under the 320px rail minimum.
    panelState = { type: "objective", id: "obj-1" };
    stubLayout({ wrapper: 1440, nav: 220, detail: 448 });
    renderRail({ withDetailPanel: true });

    const aside = rail() as HTMLElement;
    expect(aside).toHaveAttribute("data-mode", "overlay");
    // Offset by the live nav width, so it floats over main content only.
    expect(aside.style.left).toBe("220px");
    expect(aside.className).toContain("z-30");
    expect(screen.queryByRole("separator", { name: "Resize panel" })).not.toBeInTheDocument();
    // Not a modal: no backdrop, and the detail panel underneath stays usable.
    expect(document.querySelector('[data-slot="sheet-overlay"]')).toBeNull();
  });

  it("docks on the same 1440px viewport once the detail panel is closed", () => {
    // 1440 - 220 - 480 = 740 available, which is room for the rail.
    stubLayout({ wrapper: 1440, nav: 220 });
    renderRail();
    expect(rail()).toHaveAttribute("data-mode", "docked");
  });

  it("keeps a docked rail's chosen width while floating", () => {
    panelState = { type: "objective", id: "obj-1" };
    stubLayout({ wrapper: 1440, nav: 220, detail: 448 });
    renderRail({ width: 520, withDetailPanel: true });
    expect((rail() as HTMLElement).style.getPropertyValue("--panel-w")).toBe("520px");
  });
});

// ── Navigation ───────────────────────────────────────────────────────────────

describe("navigation", () => {
  it("never navigates on its own — that is the entire point of the rail", () => {
    renderRail();
    expect(push).not.toHaveBeenCalled();
    // Including when a turn creates a conversation, which on the full page
    // rewrites the URL to `?c=`.
    fireEvent.click(screen.getByRole("button", { name: "fire-created" }));
    expect(push).not.toHaveBeenCalled();
  });

  it("hands the active thread to the full page on expand, and closes itself first", () => {
    renderRail();
    fireEvent.click(screen.getByRole("button", { name: "fire-created" }));
    fireEvent.click(screen.getByRole("button", { name: "Open in full page" }));

    expect(push).toHaveBeenCalledWith("/acme/product/agent?c=conv-new");
    // Two live AgentChats would mean two streams against one conversation.
    expect(rail()).toBeNull();
  });

  it("expands to a fresh chat when no thread is selected", () => {
    renderRail();
    fireEvent.click(screen.getByRole("button", { name: "Open in full page" }));
    expect(push).toHaveBeenCalledWith("/acme/product/agent");
  });
});

// ── Transcript ownership ─────────────────────────────────────────────────────

describe("conversation handling", () => {
  it("loads the thread list on open, and starts on a new chat", async () => {
    renderRail();
    await vi.waitFor(() =>
      expect(fetchCalls).toContain("/api/agent/conversations?workspaceId=ws-1"),
    );
    // No transcript request: a new chat has no id to fetch.
    expect(fetchCalls.some((url) => url.includes("/messages"))).toBe(false);
    expect(lastChatProps.activeConversationId).toBeNull();
    expect(lastChatProps.variant).toBe("rail");
  });

  it("adopts a conversation it just created without refetching its transcript", async () => {
    renderRail();
    await vi.waitFor(() => expect(fetchCalls.length).toBeGreaterThan(0));
    fetchCalls = [];

    fireEvent.click(screen.getByRole("button", { name: "fire-created" }));

    // The id is adopted...
    expect(lastChatProps.activeConversationId).toBe("conv-new");
    // ...the list is refreshed, because only the server knows the new title...
    await vi.waitFor(() =>
      expect(fetchCalls).toContain("/api/agent/conversations?workspaceId=ws-1"),
    );
    // ...but the messages are *not* refetched. That request would replace the
    // transcript that just streamed into view with a fresh copy, flickering it
    // at best and truncating the last turn at worst.
    expect(fetchCalls.some((url) => url.includes("/messages"))).toBe(false);
  });

  it("does not remount the chat when a created conversation is adopted", () => {
    renderRail();
    const mountsBefore = chatMounts;
    fireEvent.click(screen.getByRole("button", { name: "fire-created" }));
    // A remount aborts the in-flight turn, which is the failure this whole
    // design is arranged to avoid.
    expect(chatMounts).toBe(mountsBefore);
  });

  it("seeds the chat with the selected thread's transcript, and never with the previous one's", async () => {
    renderRail();
    await selectThread("First chat");

    // Empty until this thread's own messages land — the alternative is handing
    // the chat another thread's transcript under this thread's id.
    expect(lastChatProps.initialMessages).toEqual([]);
    await vi.waitFor(() =>
      expect(lastChatProps.initialMessages).toEqual([
        { id: "m-conv-1", role: "assistant", content: "hi" },
      ]),
    );
    expect(fetchCalls).toContain("/api/agent/conversations/conv-1/messages?workspaceId=ws-1");
  });

  it("refetches an adopted thread's transcript once the user has navigated away and back", async () => {
    renderRail();
    fireEvent.click(screen.getByRole("button", { name: "fire-created" }));
    await selectThread("First chat");
    await vi.waitFor(() => expect(lastChatProps.activeConversationId).toBe("conv-1"));
    fetchCalls = [];

    await selectThread("Second chat");

    // The skip is consumed by the turn that earned it. Keeping it forever would
    // leave the return visit showing an empty transcript for a thread that has
    // one.
    await vi.waitFor(() =>
      expect(fetchCalls).toContain("/api/agent/conversations/conv-new/messages?workspaceId=ws-1"),
    );
  });

  it("passes a referentially stable empty transcript so the chat is not re-seeded", () => {
    const { rerender } = renderRail();
    const first = lastChatProps.initialMessages;
    rerender(
      <Harness>
        <AgentRailProvider initialPin={{ pinned: true, width: PANEL_WIDTH_DEFAULT }}>
          <AgentRail workspaceId="ws-1" basePath="/acme/product" userInitials="RB" />
        </AgentRailProvider>
      </Harness>,
    );
    // AgentChat re-seeds on a change of *identity*, so a fresh [] per render
    // would wipe the thread on every parent render.
    expect(lastChatProps.initialMessages).toBe(first);
  });
});
