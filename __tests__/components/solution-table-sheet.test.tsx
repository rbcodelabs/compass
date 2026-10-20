// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { SolutionTableView, type SolutionTableEditing } from "@/components/solutions/solution-table-view";
import type { SolutionBacklogItem } from "@/components/solutions/solution-backlog-board";

const openPanel = vi.fn();
const createSolutionsBatch = vi.fn();

vi.mock("@/components/panels/panel-context", () => ({ usePanelContext: () => ({ openPanel }) }));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/actions", () => ({
  createSolutionsBatch: (...args: unknown[]) => createSolutionsBatch(...args),
}));

function item(id: string, title: string): SolutionBacklogItem {
  return {
    id,
    title,
    description: null,
    status: "IDEA",
    sortOrder: 0,
    _count: { assumptions: 0, evidence: 0 },
    score: null,
    opportunity: { id: "opp-1", title: "Onboarding", squad: null },
  };
}

const editing: SolutionTableEditing = {
  parents: [
    { id: "opp-1", title: "Onboarding" },
    { id: "opp-2", title: "Churn" },
  ],
  readOnly: false,
};

const rowEl = (id: string) => document.querySelector<HTMLElement>(`[data-row-id="${id}"]`)!;
const cellEl = (rowId: string, col: string) => rowEl(rowId).querySelector<HTMLElement>(`[data-col="${col}"]`)!;

function renderView(over: Partial<React.ComponentProps<typeof SolutionTableView>> = {}) {
  return render(
    <SolutionTableView solutions={[item("s1", "Wizard")]} orgSlug="acme" workspaceSlug="product" editing={editing} {...over} />,
  );
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

afterEach(() => {
  cleanup();
  openPanel.mockReset();
  createSolutionsBatch.mockReset();
  vi.unstubAllGlobals();
});

describe("SolutionTableView in sheet mode", () => {
  it("stays the plain table without `editing`", () => {
    renderView({ editing: undefined });
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(screen.queryByTestId("grid-draft-area")).not.toBeInTheDocument();
  });

  it("is a grid with a draft area and a parent picker", () => {
    renderView();
    expect(screen.getByRole("grid")).toBeInTheDocument();
    expect(screen.getByTestId("grid-draft-area")).toBeInTheDocument();
    expect(screen.getByLabelText("Opportunity", { selector: "select" })).toBeInTheDocument();
  });

  it("edits the title through the solution panel save path; Alt+Enter opens the panel", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    renderView();
    const cell = cellEl("s1", "title");
    act(() => cell.focus());
    fireEvent.keyDown(cell, { key: "Enter", altKey: true });
    expect(openPanel).toHaveBeenCalledWith("solution", "s1");

    fireEvent.keyDown(cell, { key: "Enter" });
    const input = screen.getByTestId("grid-cell-input");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/panels/entity/solution/s1?orgSlug=acme&workspaceSlug=product");
    expect(JSON.parse(init.body as string)).toEqual({ field: "title", value: "Renamed" });
  });

  it("makes the status cell editable and the parent cell not", () => {
    renderView();
    expect(cellEl("s1", "status")).not.toHaveAttribute("aria-readonly", "true");
    expect(cellEl("s1", "opportunity")).toHaveAttribute("aria-readonly", "true");
  });

  it("creates drafts under the chosen opportunity", async () => {
    createSolutionsBatch.mockImplementation(async (_o: string, _w: string, items: { clientId: string }[]) => ({
      ok: true,
      results: items.map((row) => ({ clientId: row.clientId, ok: true, id: row.clientId })),
    }));
    renderView();
    fireEvent.change(screen.getByLabelText("Opportunity", { selector: "select" }), { target: { value: "opp-2" } });
    fireEvent.change(screen.getAllByLabelText(/^Title for solution draft/)[0], { target: { value: "Win-back" } });
    fireEvent.click(screen.getByTestId("draft-create"));
    await waitFor(() => expect(createSolutionsBatch).toHaveBeenCalledTimes(1));
    expect(createSolutionsBatch).toHaveBeenCalledWith("acme", "product", [
      { clientId: expect.any(String), title: "Win-back", description: null, parent: { id: "opp-2" } },
    ]);
    await waitFor(() => expect(screen.queryAllByTestId("draft-row")).toHaveLength(0));
  });

  it("shows a parent-not-found result on the row", async () => {
    createSolutionsBatch.mockImplementation(async (_o: string, _w: string, items: { clientId: string }[]) => ({
      ok: true,
      results: items.map((row) => ({
        clientId: row.clientId,
        ok: false,
        code: "NOT_FOUND",
        error: "That opportunity was not found in this workspace.",
        field: "parent",
      })),
    }));
    renderView();
    fireEvent.change(screen.getByLabelText("Opportunity", { selector: "select" }), { target: { value: "opp-1" } });
    fireEvent.change(screen.getAllByLabelText(/^Title for solution draft/)[0], { target: { value: "X" } });
    fireEvent.click(screen.getByTestId("draft-create"));
    await waitFor(() => expect(screen.getByTestId("draft-field-error")).toHaveTextContent(/not found in this workspace/));
  });

  it("respects readOnly: no draft area, editors disabled", () => {
    renderView({ editing: { ...editing, readOnly: true } });
    expect(screen.queryByTestId("grid-draft-area")).not.toBeInTheDocument();
    expect(cellEl("s1", "title")).toHaveAttribute("aria-readonly", "true");
    expect(cellEl("s1", "status")).toHaveAttribute("aria-readonly", "true");
  });

  it("renders the grid with the draft area for an empty backlog, but the plain message when read-only", () => {
    const { unmount } = renderView({ solutions: [] });
    expect(screen.getByTestId("grid-draft-area")).toBeInTheDocument();
    unmount();
    renderView({ solutions: [], editing: { ...editing, readOnly: true } });
    expect(screen.getByText("No solutions match the current filters.")).toBeInTheDocument();
    expect(screen.queryByTestId("grid-draft-area")).not.toBeInTheDocument();
  });
});
