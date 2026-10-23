// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const refresh = vi.fn();
const router = { refresh };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import {
  LIVE_REFRESH_INTERVAL_MS,
  LIVE_REFRESH_MAX_BACKOFF_MS,
  nextPollDelay,
  useLiveRefresh,
} from "@/hooks/use-live-refresh";

let token = "t1";
let fetchMock: ReturnType<typeof vi.fn>;
let visibility: "visible" | "hidden" = "visible";

function setVisibility(next: "visible" | "hidden") {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Flush the fetch promise chain after advancing timers. */
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function mount(props: Partial<Parameters<typeof useLiveRefresh>[0]> = {}) {
  return renderHook((p: Parameters<typeof useLiveRefresh>[0]) => useLiveRefresh(p), {
    initialProps: { orgSlug: "acme", workspaceSlug: "web", scope: "tasks", ...props },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  token = "t1";
  visibility = "visible";
  refresh.mockReset();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ token }) }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("nextPollDelay", () => {
  it("uses the base interval until something fails, then doubles up to the cap", () => {
    expect(nextPollDelay(0)).toBe(LIVE_REFRESH_INTERVAL_MS);
    expect(nextPollDelay(1)).toBe(LIVE_REFRESH_INTERVAL_MS * 2);
    expect(nextPollDelay(2)).toBe(LIVE_REFRESH_INTERVAL_MS * 4);
    expect(nextPollDelay(20)).toBe(LIVE_REFRESH_MAX_BACKOFF_MS);
  });
});

describe("useLiveRefresh", () => {
  it("records a baseline on mount without refreshing", async () => {
    mount();
    await tick(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/live/change-token?orgSlug=acme&workspaceSlug=web&scope=tasks");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("polls on the interval and refreshes only when the token changes", async () => {
    mount();
    await tick(0);

    await tick(LIVE_REFRESH_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refresh).not.toHaveBeenCalled();

    token = "t2";
    await tick(LIVE_REFRESH_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);

    // Same token again: no further refresh.
    await tick(LIVE_REFRESH_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("calls onBeforeRefresh before refreshing", async () => {
    const order: string[] = [];
    refresh.mockImplementation(() => order.push("refresh"));
    mount({ onBeforeRefresh: () => order.push("capture") });
    await tick(0);
    token = "t2";
    await tick(LIVE_REFRESH_INTERVAL_MS);
    expect(order).toEqual(["capture", "refresh"]);
  });

  it("stops polling while hidden and polls immediately when visible again", async () => {
    mount();
    await tick(0);
    setVisibility("hidden");
    await tick(LIVE_REFRESH_INTERVAL_MS * 4);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    token = "t2";
    setVisibility("visible");
    await tick(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh while paused, and refreshes once the pause lifts", async () => {
    const hook = mount({ paused: true });
    await tick(0);
    token = "t2";
    await tick(LIVE_REFRESH_INTERVAL_MS);
    await tick(LIVE_REFRESH_INTERVAL_MS);
    expect(refresh).not.toHaveBeenCalled();

    hook.rerender({ orgSlug: "acme", workspaceSlug: "web", scope: "tasks", paused: false });
    await tick(LIVE_REFRESH_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("backs off on errors, never refreshes on them, and recovers", async () => {
    mount();
    await tick(0);
    fetchMock.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }));

    await tick(LIVE_REFRESH_INTERVAL_MS); // fails -> next delay 2x
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await tick(LIVE_REFRESH_INTERVAL_MS); // still waiting out the backoff
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await tick(LIVE_REFRESH_INTERVAL_MS); // 2x elapsed
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(refresh).not.toHaveBeenCalled();

    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ token: "t1" }) }));
    await tick(LIVE_REFRESH_INTERVAL_MS * 4);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await tick(LIVE_REFRESH_INTERVAL_MS); // back to the base interval
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("stops polling after unmount", async () => {
    const hook = mount();
    await tick(0);
    hook.unmount();
    await tick(LIVE_REFRESH_INTERVAL_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("polls an entity-scoped token with the scope URL-encoded", async () => {
    mount({ scope: "artifact:abc" });
    await tick(0);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/live/change-token?orgSlug=acme&workspaceSlug=web&scope=artifact%3Aabc");
  });

  it("calls onChange instead of router.refresh when provided", async () => {
    const onChange = vi.fn();
    mount({ scope: "docs-tree", onChange });
    await tick(0);
    token = "t2";
    await tick(LIVE_REFRESH_INTERVAL_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not poll while disabled, and starts once enabled", async () => {
    const hook = mount({ enabled: false });
    await tick(LIVE_REFRESH_INTERVAL_MS * 2);
    expect(fetchMock).not.toHaveBeenCalled();
    hook.rerender({ orgSlug: "acme", workspaceSlug: "web", scope: "tasks", enabled: true });
    await tick(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
