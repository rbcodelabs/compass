// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const mocks = vi.hoisted(() => ({
  moveExperiment: vi.fn(),
  handlers: {} as Record<string, (event: unknown) => void>,
  dndProps: {} as Record<string, unknown>,
}));

vi.mock("@/app/[orgSlug]/[workspaceSlug]/experiments/actions", () => ({
  moveExperiment: mocks.moveExperiment,
  reorderExperiment: vi.fn(),
  archiveExperiment: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/org/ws/experiments",
  useSearchParams: () => new URLSearchParams(),
}));
// Capture the board's drag handlers on every render so the test can drive them with synthetic dnd-kit events.
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: Record<string, unknown> & { children: React.ReactNode }) => {
      mocks.dndProps = props;
      mocks.handlers.start = props.onDragStart as (event: unknown) => void;
      mocks.handlers.over = props.onDragOver as (event: unknown) => void;
      mocks.handlers.end = props.onDragEnd as (event: unknown) => void;
      mocks.handlers.cancel = props.onDragCancel as (event: unknown) => void;
      return <actual.DndContext {...(props as object)} />;
    },
  };
});

import { PanelProvider } from "@/components/panels/panel-context";
import { ExperimentBoard } from "@/components/experiments/experiment-board";
import type { ExperimentCardData } from "@/components/experiments/experiment-card";

const STORAGE_KEY = "compass:experiments-column-layout:w1";

function experiment(id: string, title: string, status: ExperimentCardData["status"]): ExperimentCardData {
  return { id, title, hypothesis: `We believe ${title}`, killCondition: "", status, sortOrder: 0, conclusion: null };
}

function Board() {
  return (
    <PanelProvider orgSlug="org" workspaceSlug="ws">
      <ExperimentBoard
        experiments={[experiment("e1", "Pricing page", "DESIGNING"), experiment("e2", "Dark mode", "KILLED"), experiment("e3", "Onboarding tour", "RUNNING")]}
        workspaceId="w1"
        orgSlug="org"
        workspaceSlug="ws"
      />
    </PanelProvider>
  );
}

const col = (status: string) => document.querySelector<HTMLElement>(`[data-experiment-column="${status}"]`);
const tab = (name: RegExp) => within(screen.getByRole("tablist", { name: "Pinned columns" })).getByRole("tab", { name });
const tabData = (status: string) => ({ current: { status, dockTab: true } });

beforeEach(() => {
  window.localStorage.clear();
  mocks.moveExperiment.mockReset();
  window.matchMedia = ((query: string) => ({
    matches: query.includes("768"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, onchange: null, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  // Killed and Complete are docked; Complete is the open panel, so the KILLED tab has no rendered column behind it.
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ columnOrder: ["DESIGNING", "RUNNING", "COMPLETE", "KILLED"], pinnedColumnIds: ["COMPLETE", "KILLED"], activePinnedId: "COMPLETE", dockCollapsed: false }),
  );
});
afterEach(() => cleanup());

describe("dragging an experiment over and onto a dock tab", () => {
  function startDrag() {
    render(<Board />);
    act(() => mocks.handlers.start({ active: { id: "e1" } }));
  }

  it("has a stable DndContext id", () => {
    render(<Board />);
    expect(typeof mocks.dndProps.id).toBe("string");
    expect(mocks.dndProps.id).not.toBe("");
  });

  it("keeps the card in its own column while hovering a tab whose column is not rendered", () => {
    startDrag();
    expect(col("KILLED")).toBeNull();
    act(() => mocks.handlers.over({ active: { id: "e1" }, over: { id: "column-KILLED", data: tabData("KILLED") } }));
    expect(col("DESIGNING")).toHaveTextContent("Pricing page");
    expect(tab(/^Killed \(1\)/)).toBeInTheDocument();
    expect(mocks.moveExperiment).not.toHaveBeenCalled();
  });

  it("resolves the drop at drag end: optimistic append to the tab's column and the move action", () => {
    startDrag();
    act(() => mocks.handlers.over({ active: { id: "e1" }, over: { id: "column-KILLED", data: tabData("KILLED") } }));
    act(() => mocks.handlers.end({ active: { id: "e1" }, over: { id: "column-KILLED", data: tabData("KILLED") } }));
    expect(col("DESIGNING")).not.toHaveTextContent("Pricing page");
    expect(tab(/^Killed \(2\)/)).toBeInTheDocument();
    expect(mocks.moveExperiment).toHaveBeenCalledWith("e1", "KILLED", "w1", "/org/ws/experiments");
  });

  it("a drop on the card's own tab is a no-op", () => {
    render(<Board />);
    act(() => mocks.handlers.start({ active: { id: "e2" } }));
    act(() => mocks.handlers.end({ active: { id: "e2" }, over: { id: "column-KILLED", data: tabData("KILLED") } }));
    expect(mocks.moveExperiment).not.toHaveBeenCalled();
    expect(tab(/^Killed \(1\)/)).toBeInTheDocument();
  });

  it("an ordinary column is still an optimistic drag-over target", () => {
    startDrag();
    act(() => mocks.handlers.over({ active: { id: "e1" }, over: { id: "column-RUNNING", data: { current: { status: "RUNNING" } } } }));
    expect(col("DESIGNING")).not.toHaveTextContent("Pricing page");
    expect(col("RUNNING")).toHaveTextContent("Pricing page");
  });

  it("a cancelled drag (Escape) puts the card back where the drag began", () => {
    startDrag();
    act(() => mocks.handlers.over({ active: { id: "e1" }, over: { id: "column-RUNNING", data: { current: { status: "RUNNING" } } } }));
    expect(col("RUNNING")).toHaveTextContent("Pricing page");
    act(() => mocks.handlers.cancel({ active: { id: "e1" } }));
    expect(col("DESIGNING")).toHaveTextContent("Pricing page");
    expect(col("RUNNING")).not.toHaveTextContent("Pricing page");
    expect(mocks.moveExperiment).not.toHaveBeenCalled();
    // the board is idle again: a click on a tab still works
    fireEvent.click(tab(/^Killed/));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Dark mode");
  });
});
