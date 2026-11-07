// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const push = vi.fn();
const create = vi.fn();
let search = "";
vi.mock("@/app/[orgSlug]/saved-views-actions", () => ({
  createSavedViewAction: (...args: unknown[]) => create(...args),
  updateSavedViewAction: vi.fn(),
  deleteSavedViewAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push, refresh: vi.fn() }),
  usePathname: () => "/org/ws/tasks",
  useSearchParams: () => new URLSearchParams(search),
}));

import { TasksSavedViewsMenu, useTasksViewState } from "@/components/tasks/tasks-saved-views";
import { TasksColumnLayoutProvider, useTasksColumnLayout } from "@/components/tasks/tasks-column-layout";
import { pinColumn } from "@/lib/board-layout";
import { resolveTaskBoardLayout } from "@/lib/tasks/board-layout";
import type { SavedViewRecord } from "@/lib/saved-views/service";

const view = (display: Record<string, unknown>, filters: Record<string, unknown> = {}): SavedViewRecord =>
  ({ id: "v1", name: "Mine", visibility: "PERSONAL", surface: "TASKS_BOARD", workspaceId: "w1", ownerId: "u", isOwner: true, canDelete: true, filters: { includeAgentTasks: false, ...filters }, display: { view: "board", ...display }, updatedAt: "t1" }) as unknown as SavedViewRecord;

type Snapshot = { modified: boolean; state: ReturnType<typeof useTasksViewState>["state"] };
const read = (): Snapshot => JSON.parse(screen.getByTestId("snapshot").textContent!);

function State({ views, savedViewId }: { views: SavedViewRecord[]; savedViewId: string | null }) {
  const { state, modified } = useTasksViewState({ views, savedViewId });
  return <output data-testid="snapshot">{JSON.stringify({ state, modified })}</output>;
}

function Pin() {
  const { update } = useTasksColumnLayout("w1");
  return <button onClick={() => update((l) => pinColumn(l, "DONE"))}>pin done</button>;
}

function Page({ views = [], savedViewId = null, layout = null }: { views?: SavedViewRecord[]; savedViewId?: string | null; layout?: unknown }) {
  return (
    <TasksColumnLayoutProvider workspaceId="w1" savedView={savedViewId ? { id: savedViewId, version: "t1", columnLayout: layout } : null}>
      <State views={views} savedViewId={savedViewId} />
      <Pin />
    </TasksColumnLayoutProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  push.mockReset();
  create.mockReset();
  search = "";
});
afterEach(() => cleanup());

describe("useTasksViewState with the column layout", () => {
  it("folds the live layout into the state Save captures, and marks a selected view modified", () => {
    render(<Page views={[view({})]} savedViewId="v1" />);
    expect(read().modified).toBe(false);
    expect(read().state.display.columnLayout).toBeUndefined();

    fireEvent.click(screen.getByText("pin done"));
    expect(read().modified).toBe(true);
    expect(read().state.display.columnLayout).toMatchObject({ pinnedColumnIds: ["DONE"], activePinnedId: "DONE" });
  });

  it("an untouched board is not modified against a saved layout it started from", () => {
    const layout = pinColumn(resolveTaskBoardLayout(undefined), "DONE");
    render(<Page views={[view({ columnLayout: layout })]} savedViewId="v1" layout={layout} />);
    expect(read().modified).toBe(false);
    expect(read().state.display.columnLayout).toEqual(layout);
  });

  it("captures the URL filters in the state Save stores", () => {
    search = "priority=HIGH&agentTasks=include";
    render(<Page />);
    expect(read().state.filters).toMatchObject({ priority: "HIGH", includeAgentTasks: true });
  });

  it("a filter edit on a selected view (edited=1) marks it modified", () => {
    search = "saved=v1&edited=1&priority=LOW";
    render(<Page views={[view({}, { priority: "HIGH" })]} savedViewId="v1" />);
    expect(read().modified).toBe(true);
  });

  it("without a saved view it is never modified", () => {
    render(<Page />);
    fireEvent.click(screen.getByText("pin done"));
    expect(read().modified).toBe(false);
  });
});

describe("TasksSavedViewsMenu", () => {
  function renderMenu(views: SavedViewRecord[], savedViewId: string | null, layout?: unknown) {
    render(
      <TasksColumnLayoutProvider workspaceId="w1" savedView={savedViewId ? { id: savedViewId, version: "t1", columnLayout: layout } : null}>
        <TasksSavedViewsMenu savedViews={{ orgSlug: "org", workspaceId: "w1", views, savedViewId, canSave: true }} />
        <Pin />
      </TasksColumnLayoutProvider>,
    );
  }

  it("lists a saved Tasks view; selecting it navigates to a bare ?saved=<id>", async () => {
    renderMenu([view({})], null);
    fireEvent.click(screen.getByTestId("saved-views-trigger"));
    const options = await screen.findAllByTestId("saved-view-option");
    expect(options.map((o) => o.textContent)).toEqual(["Mine"]);
    fireEvent.click(options[0]);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0]).toBe("/org/ws/tasks?saved=v1");
  });

  it("Save as new captures the URL filters AND the live column layout under the TASKS_BOARD surface", async () => {
    search = "priority=HIGH";
    create.mockResolvedValue({ ok: true, view: view({}) });
    renderMenu([], null);
    fireEvent.click(screen.getByText("pin done"));
    fireEvent.click(screen.getByTestId("saved-views-trigger"));
    fireEvent.click(await screen.findByTestId("save-view-new"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Urgent + Done pinned" } });
    fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    const [orgSlug, surface, workspaceId, payload] = create.mock.calls[0];
    expect([orgSlug, surface, workspaceId]).toEqual(["org", "TASKS_BOARD", "w1"]);
    expect(payload).toMatchObject({
      name: "Urgent + Done pinned",
      visibility: "PERSONAL",
      filters: { priority: "HIGH", includeAgentTasks: false },
      display: { view: "board", columnLayout: { pinnedColumnIds: ["DONE"], activePinnedId: "DONE", dockCollapsed: false } },
    });
  });

  it("Reset (re-selecting the open view) puts the board's layout back to what the view saved", () => {
    search = "saved=v1&edited=1";
    render(
      <TasksColumnLayoutProvider workspaceId="w1" savedView={{ id: "v1", version: "t1", columnLayout: undefined }}>
        <TasksSavedViewsMenu savedViews={{ orgSlug: "org", workspaceId: "w1", views: [view({})], savedViewId: "v1", canSave: true }} />
        <State views={[view({})]} savedViewId="v1" />
        <Pin />
      </TasksColumnLayoutProvider>,
    );
    fireEvent.click(screen.getByText("pin done"));
    expect(read().modified).toBe(true);
    fireEvent.click(screen.getByTestId("reset-view"));
    expect(read().state.display.columnLayout).toBeUndefined();
    expect(push.mock.calls.at(-1)?.[0]).toBe("/org/ws/tasks?saved=v1");
  });

  it("shows Modified once the layout changes, and has no Share control (personal only)", () => {
    search = "saved=v1&edited=1";
    renderMenu([view({})], "v1");
    expect(screen.queryByTestId("saved-view-modified")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("pin done"));
    expect(screen.getByTestId("saved-view-modified")).toBeInTheDocument();
    expect(screen.queryByText(/share/i)).not.toBeInTheDocument();
  });
});
