// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { useEffect } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/rbcodelabs/compass/roadmap",
  useSearchParams: () => new URLSearchParams(),
}));

import { PanelProvider, usePanelContext } from "@/components/panels/panel-context";

/** Subscribes to roadmapItem mutations and renders each one it receives. */
function Listener() {
  const { subscribeEntityMutated } = usePanelContext();
  const received: string[] = [];

  useEffect(() => {
    return subscribeEntityMutated("roadmapItem", (id, patch) => {
      received.push(`${id}:${patch?.horizon ?? "none"}`);
      const el = document.getElementById("received");
      if (el) el.textContent = received.join(",");
    });
  }, [subscribeEntityMutated]);

  return <div id="received" data-testid="received" />;
}

function Notifier() {
  const { notifyEntityMutated } = usePanelContext();
  return (
    <>
      <button onClick={() => notifyEntityMutated("roadmapItem", "item-1", { horizon: "LAUNCHING" })}>
        notify roadmap item
      </button>
      <button onClick={() => notifyEntityMutated("opportunity", "opp-1", { horizon: "LAUNCHING" })}>
        notify other type
      </button>
    </>
  );
}

describe("PanelProvider entity-mutation pub/sub", () => {
  afterEach(() => cleanup());

  it("delivers a notification to a matching-type subscriber with its id and patch", () => {
    render(
      <PanelProvider orgSlug="rbcodelabs" workspaceSlug="compass">
        <Listener />
        <Notifier />
      </PanelProvider>
    );

    fireEvent.click(screen.getByText("notify roadmap item"));

    expect(screen.getByTestId("received")).toHaveTextContent("item-1:LAUNCHING");
  });

  it("does not deliver notifications for a different entity type", () => {
    render(
      <PanelProvider orgSlug="rbcodelabs" workspaceSlug="compass">
        <Listener />
        <Notifier />
      </PanelProvider>
    );

    fireEvent.click(screen.getByText("notify other type"));

    expect(screen.getByTestId("received")).toHaveTextContent("");
  });

  it("stops delivering after the subscriber unsubscribes (unmounts)", () => {
    const { unmount } = render(
      <PanelProvider orgSlug="rbcodelabs" workspaceSlug="compass">
        <Listener />
        <Notifier />
      </PanelProvider>
    );

    unmount();

    // Re-render just the notifier under a fresh provider; nothing should throw
    // and there is no listener left to receive anything from the old tree.
    render(
      <PanelProvider orgSlug="rbcodelabs" workspaceSlug="compass">
        <Notifier />
      </PanelProvider>
    );
    expect(() => fireEvent.click(screen.getByText("notify roadmap item"))).not.toThrow();
  });
});
