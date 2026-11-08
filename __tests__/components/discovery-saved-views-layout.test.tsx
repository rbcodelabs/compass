// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const replace = vi.fn();
let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/org/ws/discovery",
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock("@/hooks/use-url-state", () => ({
  useUrlState: () => ({ params: new URLSearchParams(search), setAll: vi.fn(), set: vi.fn() }),
}));

import { ColumnsPopover } from "@/components/discovery/columns-popover";
import { useDiscoveryViewState } from "@/components/discovery/discovery-saved-views";
import { OpportunitiesColumnLayoutProvider, useOpportunitiesColumnLayout } from "@/components/discovery/discovery-column-layout";
import { pinColumn } from "@/lib/board-layout";
import { resolveOpportunityColumns } from "@/lib/saved-views/opportunity-columns";
import { resolveOpportunityBoardLayout } from "@/lib/discovery/board-layout";
import type { SavedViewRecord } from "@/lib/saved-views/service";

const view = (display: Record<string, unknown>): SavedViewRecord =>
  ({ id: "v1", name: "V", visibility: "PERSONAL", surface: "OPPORTUNITIES_BOARD", workspaceId: "w1", ownerId: "u", isOwner: true, canDelete: true, filters: { squadIds: [] }, display: { view: "board", groupBy: "status", sort: "manual", columns: {}, ...display }, updatedAt: "t1" }) as unknown as SavedViewRecord;

type Snapshot = { modified: boolean; state: ReturnType<typeof useDiscoveryViewState>["state"] };
const read = (): Snapshot => JSON.parse(screen.getByTestId("snapshot").textContent!);

function State({ views, savedViewId }: { views: SavedViewRecord[]; savedViewId: string | null }) {
  const { state, modified } = useDiscoveryViewState({ views, savedViewId });
  return <output data-testid="snapshot">{JSON.stringify({ state, modified })}</output>;
}

function Pin() {
  const { update } = useOpportunitiesColumnLayout("w1");
  return <button onClick={() => update((l) => pinColumn(l, "EXPLORING"))}>pin exploring</button>;
}

function Page({ views = [], savedViewId = null, layout = null }: { views?: SavedViewRecord[]; savedViewId?: string | null; layout?: unknown }) {
  return (
    <OpportunitiesColumnLayoutProvider workspaceId="w1" savedView={savedViewId ? { id: savedViewId, version: "t1", columnLayout: layout } : null}>
      <State views={views} savedViewId={savedViewId} />
      <Pin />
    </OpportunitiesColumnLayoutProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  replace.mockReset();
  search = "";
});
afterEach(() => cleanup());

describe("useDiscoveryViewState with the column layout", () => {
  it("folds the live layout into the state Save captures, and marks a selected view modified", () => {
    render(<Page views={[view({})]} savedViewId="v1" />);
    expect(read().modified).toBe(false);
    expect(read().state.display.columnLayout).toBeUndefined();

    fireEvent.click(screen.getByText("pin exploring"));
    expect(read().modified).toBe(true);
    expect(read().state.display.columnLayout).toMatchObject({ pinnedColumnIds: ["EXPLORING"], activePinnedId: "EXPLORING" });
  });

  it("an untouched board is not modified against a saved layout it started from", () => {
    const layout = pinColumn(resolveOpportunityBoardLayout(undefined), "EXPLORING");
    render(<Page views={[view({ columnLayout: layout })]} savedViewId="v1" layout={layout} />);
    expect(read().modified).toBe(false);
    expect(read().state.display.columnLayout).toEqual(layout);
  });

  it("an untouched legacy-order view (started from the layout its order describes) is not modified", () => {
    const legacy = { columns: { status: { order: ["EXPLORING", "VALIDATING"], hidden: [] } } };
    const startLayout = { columnOrder: ["EXPLORING", "VALIDATING", "ACTIVE", "PRIORITIZED", "UNREVIEWED"], pinnedColumnIds: [] };
    render(<Page views={[view(legacy)]} savedViewId="v1" layout={startLayout} />);
    expect(read().modified).toBe(false);
  });

  it("without a saved view it is never modified", () => {
    render(<Page />);
    fireEvent.click(screen.getByText("pin exploring"));
    expect(read().modified).toBe(false);
  });
});

describe("ColumnsPopover (Discovery)", () => {
  const counts = { EXPLORING: 1, VALIDATING: 1, PRIORITIZED: 0, ACTIVE: 1 };

  function renderPopover() {
    render(
      <OpportunitiesColumnLayoutProvider workspaceId="w1" savedView={null}>
        <ColumnsPopover workspaceId="w1" savedViews={{ views: [], savedViewId: null }} columns={resolveOpportunityColumns(undefined, counts)} countsByStatus={counts} />
      </OpportunitiesColumnLayoutProvider>,
    );
    fireEvent.click(screen.getByTestId("columns-trigger"));
  }
  const rows = () => [...document.querySelectorAll("[data-testid^=columns-row-]")].map((r) => r.getAttribute("data-testid"));

  it("lists the columns in the layout's order", () => {
    window.localStorage.setItem(
      "compass:discovery-column-layout:w1",
      JSON.stringify({ columnOrder: ["EXPLORING", "PRIORITIZED", "ACTIVE", "VALIDATING"], pinnedColumnIds: [] }),
    );
    renderPopover();
    expect(rows()).toEqual(["columns-row-EXPLORING", "columns-row-PRIORITIZED", "columns-row-ACTIVE", "columns-row-VALIDATING", "columns-row-UNREVIEWED"]); // a layout stored before Unreviewed existed gets it appended
  });

  it("reordering writes the layout (localStorage), not the URL", () => {
    renderPopover();
    fireEvent.click(screen.getByLabelText("Move Active down"));
    expect(replace).not.toHaveBeenCalled();
    const stored = JSON.parse(window.localStorage.getItem("compass:discovery-column-layout:w1")!);
    expect(stored.columnOrder).toEqual(["PRIORITIZED", "ACTIVE", "VALIDATING", "EXPLORING", "UNREVIEWED"]);
    expect(rows()[0]).toBe("columns-row-PRIORITIZED");
  });

  it("hiding still goes to the URL (hide), keeping hide as the popover's job", () => {
    renderPopover();
    fireEvent.click(screen.getByLabelText("Show Prioritized"));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0][0]).toContain("hide=PRIORITIZED");
    expect(replace.mock.calls[0][0]).not.toContain("order=");
  });

  it("disables moving past either end of the layout order", () => {
    renderPopover();
    expect(screen.getByLabelText("Move Active up")).toBeDisabled();
    expect(screen.getByLabelText("Move Unreviewed down")).toBeDisabled();
  });
});
