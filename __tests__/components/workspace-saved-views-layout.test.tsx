// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const createAction = vi.fn();
const updateAction = vi.fn();
vi.mock("@/app/[orgSlug]/saved-views-actions", () => ({
  createSavedViewAction: (...args: unknown[]) => createAction(...args),
  updateSavedViewAction: (...args: unknown[]) => updateAction(...args),
  deleteSavedViewAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/hooks/use-url-state", () => ({
  useUrlState: () => ({ params: new URLSearchParams("edited=1"), setAll: vi.fn(), set: vi.fn() }),
}));

import { RoadmapColumnLayoutProvider, useRoadmapColumnLayoutContext } from "@/components/roadmap/column-layout-context";
import { WorkspaceSavedViewsMenu, type WorkspaceSavedViews } from "@/components/roadmap/workspace-saved-views";
import { pinColumn } from "@/lib/board-layout";
import { DEFAULT_ROADMAP_DISPLAY, DEFAULT_ROADMAP_FILTERS } from "@/lib/roadmap-views/schema";
import type { RoadmapViewRecord } from "@/lib/roadmap-views/service";

const WS = "11111111-1111-4111-8111-111111111111";
const VIEW_ID = "22222222-2222-4222-8222-222222222222";

function view(columnLayout?: unknown): RoadmapViewRecord {
  return {
    id: VIEW_ID, name: "My view", visibility: "PERSONAL", surface: "ROADMAP_WORKSPACE", workspaceId: WS, ownerId: "u1",
    isOwner: true, canDelete: true, filters: DEFAULT_ROADMAP_FILTERS,
    display: { ...DEFAULT_ROADMAP_DISPLAY, columnLayout } as RoadmapViewRecord["display"],
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

function PinLater() {
  const ctx = useRoadmapColumnLayoutContext();
  return <button onClick={() => ctx?.update((l) => pinColumn(l, "LATER"))}>pin later</button>;
}

function Menu({ saved }: { saved: RoadmapViewRecord | null }) {
  const props: WorkspaceSavedViews = {
    orgSlug: "acme", workspaceId: WS, views: saved ? [saved] : [], savedViewId: saved?.id ?? null, modified: false, canShare: false,
  };
  return (
    <RoadmapColumnLayoutProvider
      workspaceId={WS}
      savedView={saved ? { id: saved.id, version: saved.updatedAt, columnLayout: (saved.display as { columnLayout?: unknown }).columnLayout } : null}
    >
      <PinLater />
      <WorkspaceSavedViewsMenu savedViews={props} />
    </RoadmapColumnLayoutProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  createAction.mockReset().mockResolvedValue({ ok: false, error: "stop here" });
  updateAction.mockReset().mockResolvedValue({ ok: false, error: "stop here" });
});
afterEach(() => cleanup());

describe("saved views menu and the column layout", () => {
  it("does not show a saved view as modified until the layout actually differs from it", () => {
    render(<Menu saved={view()} />);
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("pin later"));
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
  });

  it("treats a view saved before layouts existed as equal to an untouched board", () => {
    render(<Menu saved={view(undefined)} />);
    expect(screen.queryByText("(modified)")).not.toBeInTheDocument();
  });

  it("'Save changes' writes the live layout into the view's display document", async () => {
    render(<Menu saved={view()} />);
    fireEvent.click(screen.getByText("pin later"));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateAction).toHaveBeenCalledTimes(1));
    const [, , , id, input] = updateAction.mock.calls[0];
    expect(id).toBe(VIEW_ID);
    expect(input.display.columnLayout.pinnedColumnIds).toContain("LATER");
    expect(input.display.columnLayout.pinnedColumnIds).toContain("unscheduled");
  });

  it("omits the layout when it is the default (a plain save adds nothing)", async () => {
    render(<Menu saved={null} />);
    fireEvent.click(screen.getByTestId("saved-views-trigger"));
    fireEvent.click(await screen.findByTestId("save-view-new"));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Plain" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(createAction).toHaveBeenCalledTimes(1));
    expect(createAction.mock.calls[0][3].display.columnLayout).toBeUndefined();
  });

  it("a new view created after a layout change carries the layout", async () => {
    render(<Menu saved={null} />);
    fireEvent.click(screen.getByText("pin later"));
    fireEvent.click(screen.getByTestId("saved-views-trigger"));
    fireEvent.click(await screen.findByTestId("save-view-new"));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "With layout" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(createAction).toHaveBeenCalledTimes(1));
    expect(createAction.mock.calls[0][3].display.columnLayout.pinnedColumnIds).toContain("LATER");
  });
});
