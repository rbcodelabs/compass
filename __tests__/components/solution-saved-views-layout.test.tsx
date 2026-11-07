// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const replace = vi.fn();
let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/org/ws/solutions",
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock("@/hooks/use-url-state", () => ({
  useUrlState: () => ({ params: new URLSearchParams(search), setAll: vi.fn(), set: vi.fn() }),
}));

import { SolutionColumnsPopover } from "@/components/solutions/solution-columns-popover";
import { useSolutionViewState } from "@/components/solutions/solution-saved-views";
import { SolutionsColumnLayoutProvider, useSolutionsColumnLayout } from "@/components/solutions/solutions-column-layout";
import { pinColumn } from "@/lib/board-layout";
import { resolveSolutionColumns } from "@/lib/saved-views/solution-columns";
import { resolveSolutionBoardLayout } from "@/lib/solutions/board-layout";
import type { SavedViewRecord } from "@/lib/saved-views/service";

const view = (display: Record<string, unknown>): SavedViewRecord =>
  ({ id: "v1", name: "V", visibility: "PERSONAL", surface: "SOLUTIONS_BOARD", workspaceId: "w1", ownerId: "u", isOwner: true, canDelete: true, filters: { squadIds: [] }, display: { view: "board", groupBy: "status", sort: "manual", columns: {}, ...display }, updatedAt: "t1" }) as unknown as SavedViewRecord;

type Snapshot = { modified: boolean; state: ReturnType<typeof useSolutionViewState>["state"] };
const read = (): Snapshot => JSON.parse(screen.getByTestId("snapshot").textContent!);

function State({ views, savedViewId }: { views: SavedViewRecord[]; savedViewId: string | null }) {
  const { state, modified } = useSolutionViewState({ views, savedViewId });
  return <output data-testid="snapshot">{JSON.stringify({ state, modified })}</output>;
}

function Pin() {
  const { update } = useSolutionsColumnLayout("w1");
  return <button onClick={() => update((l) => pinColumn(l, "SHIPPED"))}>pin shipped</button>;
}

function Page({ views = [], savedViewId = null, layout = null }: { views?: SavedViewRecord[]; savedViewId?: string | null; layout?: unknown }) {
  return (
    <SolutionsColumnLayoutProvider workspaceId="w1" savedView={savedViewId ? { id: savedViewId, version: "t1", columnLayout: layout } : null}>
      <State views={views} savedViewId={savedViewId} />
      <Pin />
    </SolutionsColumnLayoutProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  replace.mockReset();
  search = "";
});
afterEach(() => cleanup());

describe("useSolutionViewState with the column layout", () => {
  it("folds the live layout into the state Save captures, and marks a selected view modified", () => {
    render(<Page views={[view({})]} savedViewId="v1" />);
    expect(read().modified).toBe(false);
    expect(read().state.display.columnLayout).toBeUndefined();

    fireEvent.click(screen.getByText("pin shipped"));
    expect(read().modified).toBe(true);
    expect(read().state.display.columnLayout).toMatchObject({ pinnedColumnIds: ["SHIPPED"], activePinnedId: "SHIPPED" });
  });

  it("an untouched board is not modified against a saved layout it started from", () => {
    const layout = pinColumn(resolveSolutionBoardLayout(undefined), "SHIPPED");
    render(<Page views={[view({ columnLayout: layout })]} savedViewId="v1" layout={layout} />);
    expect(read().modified).toBe(false);
    expect(read().state.display.columnLayout).toEqual(layout);
  });

  it("an untouched legacy-order view (started from the layout its order describes) is not modified", () => {
    const legacy = { columns: { status: { order: ["IDEA", "SHIPPED"], hidden: [] } } };
    const startLayout = { columnOrder: ["IDEA", "SHIPPED", "IN_DELIVERY", "VALIDATED", "KILLED"], pinnedColumnIds: [] };
    render(<Page views={[view(legacy)]} savedViewId="v1" layout={startLayout} />);
    expect(read().modified).toBe(false);
  });

  it("without a saved view it is never modified", () => {
    render(<Page />);
    fireEvent.click(screen.getByText("pin shipped"));
    expect(read().modified).toBe(false);
  });
});

describe("SolutionColumnsPopover", () => {
  const counts = { IN_DELIVERY: 1, VALIDATED: 1, IDEA: 1, SHIPPED: 1, KILLED: 0 };

  function renderPopover() {
    render(
      <SolutionsColumnLayoutProvider workspaceId="w1" savedView={null}>
        <SolutionColumnsPopover workspaceId="w1" savedViews={{ views: [], savedViewId: null }} columns={resolveSolutionColumns(undefined, counts)} countsByStatus={counts} />
        <Pin />
      </SolutionsColumnLayoutProvider>,
    );
    fireEvent.click(screen.getByTestId("columns-trigger"));
  }

  it("lists the columns in the layout's order", () => {
    window.localStorage.setItem(
      "compass:solutions-column-layout:w1",
      JSON.stringify({ columnOrder: ["KILLED", "IDEA", "IN_DELIVERY", "VALIDATED", "SHIPPED"], pinnedColumnIds: [] }),
    );
    renderPopover();
    const rows = [...document.querySelectorAll("[data-testid^=columns-row-]")].map((r) => r.getAttribute("data-testid"));
    expect(rows).toEqual(["columns-row-KILLED", "columns-row-IDEA", "columns-row-IN_DELIVERY", "columns-row-VALIDATED", "columns-row-SHIPPED"]);
  });

  it("reordering writes the layout (localStorage), not the URL", () => {
    renderPopover();
    fireEvent.click(screen.getByLabelText("Move In delivery down"));
    expect(replace).not.toHaveBeenCalled();
    const stored = JSON.parse(window.localStorage.getItem("compass:solutions-column-layout:w1")!);
    expect(stored.columnOrder).toEqual(["VALIDATED", "IN_DELIVERY", "IDEA", "SHIPPED", "KILLED"]);
    const rows = [...document.querySelectorAll("[data-testid^=columns-row-]")].map((r) => r.getAttribute("data-testid"));
    expect(rows[0]).toBe("columns-row-VALIDATED");
  });

  it("hiding still goes to the URL (hide), keeping hide as the popover's job", () => {
    renderPopover();
    fireEvent.click(screen.getByLabelText("Show Killed"));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0][0]).toContain("hide=KILLED");
    expect(replace.mock.calls[0][0]).not.toContain("order=");
  });

  it("disables moving past either end of the layout order", () => {
    renderPopover();
    expect(screen.getByLabelText("Move In delivery up")).toBeDisabled();
    expect(screen.getByLabelText("Move Killed down")).toBeDisabled();
  });
});
