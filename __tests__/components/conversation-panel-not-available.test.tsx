// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const closePanel = vi.fn();
// Stable identities: the provider effects depend on these, and a fresh object per render would loop.
const stable = vi.hoisted(() => ({
  panelContext: null as unknown,
  labels: {},
  titles: {},
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/acme/main/okrs",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => {
    stable.panelContext ??= { panel: { type: "conversation", id: "c1" }, openPanel: () => undefined, closePanel };
    return stable.panelContext;
  },
}));
vi.mock("@/components/panels/panel-titles", () => ({ panelTitles: () => stable.titles }));
vi.mock("@/components/thinking-model/thinking-model-provider", () => ({ useLabels: () => stable.labels }));
vi.mock("@/components/agent/agent-chat", () => ({
  AgentChat: (props: { initialMessages: { content: string }[]; initialStatus: string }) => (
    <div data-testid="agent-chat" data-status={props.initialStatus}>
      {props.initialMessages.map((m) => m.content).join("|")}
    </div>
  ),
}));

import { ConversationPanel, ConversationPanelProvider } from "@/components/panels/conversation-panel";

let responses: Record<"messages" | "settings", { status: number; body: unknown }>;
let calls: string[];

beforeEach(() => {
  calls = [];
  responses = {
    messages: { status: 200, body: { messages: [{ id: "m1", role: "user", content: "hello" }] } },
    settings: { status: 200, body: { status: "OPEN", visibility: "PRIVATE", agentMode: "AUTO" } },
  };
  closePanel.mockClear();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const r = url.includes("/messages")
      ? responses.messages
      : url.includes("/settings")
        ? responses.settings
        : { status: 200, body: { conversations: [] } };
    return new Response(r.status === 404 ? "Not found" : JSON.stringify(r.body), { status: r.status });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  return render(
    <ConversationPanelProvider workspaceId="w1" userId="u1" userInitials="U" orgSlug="acme" workspaceSlug="main">
      <ConversationPanel conversationId="c1" />
    </ConversationPanelProvider>,
  );
}

const notAvailable = () => screen.queryByTestId("conversation-not-available");

describe("ConversationPanel not-available state", () => {
  it("shows one neutral state, with focus on its heading, when both reads 404", async () => {
    responses.messages = { status: 404, body: null };
    responses.settings = { status: 404, body: null };
    mount();
    await waitFor(() => expect(notAvailable()).not.toBeNull());
    // Focus is asserted as an eventual state: the panel swaps its content in a later commit than the one the first waitFor saw.
    await waitFor(() => expect(screen.getByRole("heading", { name: "Not available" })).toHaveFocus());
    expect(notAvailable()).toHaveAttribute("role", "status");
    expect(screen.queryByTestId("agent-chat")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(closePanel).toHaveBeenCalled();
  });

  it("renders identical DOM whichever read reported the 404", async () => {
    responses.messages = { status: 404, body: null };
    const first = mount();
    await waitFor(() => expect(notAvailable()).not.toBeNull());
    const a = notAvailable()!.outerHTML;
    first.unmount();
    responses.messages = { status: 200, body: { messages: [] } };
    responses.settings = { status: 404, body: null };
    mount();
    await waitFor(() => expect(notAvailable()).not.toBeNull());
    expect(notAvailable()!.outerHTML).toBe(a);
  });

  it("does not retry after a 404", async () => {
    responses.messages = { status: 404, body: null };
    responses.settings = { status: 404, body: null };
    mount();
    await waitFor(() => expect(notAvailable()).not.toBeNull());
    const settled = calls.filter((c) => c.includes("/messages") || c.includes("/settings")).length;
    await new Promise((r) => setTimeout(r, 150));
    expect(calls.filter((c) => c.includes("/messages") || c.includes("/settings")).length).toBe(settled);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps a readable conversation, including an archived one, in the chat", async () => {
    responses.settings = { status: 200, body: { status: "ARCHIVED", visibility: "WORKSPACE", agentMode: "MENTION_ONLY" } };
    mount();
    await waitFor(() => expect(screen.getByTestId("agent-chat")).toHaveAttribute("data-status", "ARCHIVED"));
    expect(screen.getByTestId("agent-chat")).toHaveTextContent("hello");
    expect(notAvailable()).toBeNull();
  });

  it("does not treat a server error as not-available", async () => {
    responses.messages = { status: 500, body: null };
    mount();
    await new Promise((r) => setTimeout(r, 100));
    expect(notAvailable()).toBeNull();
  });
});
