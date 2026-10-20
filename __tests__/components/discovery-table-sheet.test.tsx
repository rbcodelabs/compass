// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import {
  DiscoveryTableView,
  type DiscoveryTableOpportunity,
  type DiscoveryTableWorkspace,
} from "@/components/discovery/discovery-table-view";

const openPanel = vi.fn();
const createOpportunitiesBatch = vi.fn();
const createSolutionsBatch = vi.fn();

vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel }),
}));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/actions", () => ({
  createOpportunitiesBatch: (...args: unknown[]) => createOpportunitiesBatch(...args),
  createSolutionsBatch: (...args: unknown[]) => createSolutionsBatch(...args),
}));

const opportunities: DiscoveryTableOpportunity[] = [
  {
    id: "opp-1",
    title: "Understand onboarding friction",
    customerSegment: "New teams",
    status: "EXPLORING",
    sortOrder: 0,
    squad: { id: "squad-1", name: "Growth", color: "#ff6600" },
    evidenceCount: 4,
    solutions: [{ id: "sol-1", title: "Guided setup", status: "IDEA", sortOrder: 0, evidenceCount: 2, assumptionCount: 3 }],
  },
];

const workspace: DiscoveryTableWorkspace = {
  orgSlug: "acme",
  workspaceSlug: "product",
  solutionParents: [
    { id: "opp-1", title: "Understand onboarding friction" },
    { id: "opp-2", title: "Reduce churn" },
    { id: "opp-3", title: "Twin" },
    { id: "opp-4", title: "Twin" },
  ],
  squads: [
    { id: "squad-1", name: "Growth", color: "#ff6600" },
    { id: "squad-2", name: "Platform", color: "#0066ff" },
  ],
  readOnly: false,
};

const rowEl = (id: string) => document.querySelector<HTMLElement>(`[data-row-id="${id}"]`)!;
const cellEl = (rowId: string, col: string) => rowEl(rowId).querySelector<HTMLElement>(`[data-col="${col}"]`)!;

function paste(text: string, label: RegExp = /^Title for opportunity draft \d+$/) {
  const target = screen.getAllByLabelText(label).at(-1)!;
  fireEvent.paste(target, { clipboardData: { getData: (type: string) => (type === "text/plain" ? text : "") } });
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
  createOpportunitiesBatch.mockReset();
  createSolutionsBatch.mockReset();
  vi.unstubAllGlobals();
});

describe("DiscoveryTableView in sheet mode", () => {
  it("stays the plain table when no workspace is supplied", () => {
    render(<DiscoveryTableView opportunities={opportunities} />);
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(screen.queryByTestId("grid-draft-area")).not.toBeInTheDocument();
  });

  it("is a grid with a draft area", () => {
    render(<DiscoveryTableView opportunities={opportunities} workspace={workspace} />);
    expect(screen.getByRole("grid")).toBeInTheDocument();
    expect(screen.getByTestId("grid-draft-area")).toBeInTheDocument();
  });

  it("Enter edits the title and saves through the opportunity panel route; Alt+Enter opens the panel", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DiscoveryTableView opportunities={opportunities} workspace={workspace} />);

    const cell = cellEl("opportunity:opp-1", "item");
    act(() => cell.focus());
    fireEvent.keyDown(cell, { key: "Enter", altKey: true });
    expect(openPanel).toHaveBeenCalledWith("opportunity", "opp-1");

    fireEvent.keyDown(cell, { key: "Enter" });
    const input = screen.getByTestId("grid-cell-input");
    expect(input).toHaveValue("Understand onboarding friction");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/panels/entity/opportunity/opp-1?orgSlug=acme&workspaceSlug=product");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ field: "title", value: "Renamed" });
    // The nested row shape is updated optimistically through applyOptimistic.
    expect(within(cellEl("opportunity:opp-1", "item")).getByRole("button", { name: "Renamed" })).toBeInTheDocument();
  });

  it("edits the customer segment through the panel route, trims, and clears with Delete", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DiscoveryTableView opportunities={opportunities} workspace={workspace} />);

    const cell = cellEl("opportunity:opp-1", "segment");
    act(() => cell.focus());
    expect(cell).toHaveAttribute("aria-readonly", "false");
    fireEvent.keyDown(cell, { key: "Enter" });
    const input = screen.getByTestId("grid-cell-input");
    expect(input).toHaveValue("New teams");
    fireEvent.change(input, { target: { value: "  Enterprise  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({
      field: "customerSegment",
      value: "Enterprise",
    });
    expect(cellEl("opportunity:opp-1", "segment")).toHaveTextContent("Enterprise");

    act(() => cellEl("opportunity:opp-1", "segment").focus());
    fireEvent.keyDown(cellEl("opportunity:opp-1", "segment"), { key: "Delete" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).toEqual({
      field: "customerSegment",
      value: null,
    });
  });

  it("rejects an over-long segment in the editor without calling the server", () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DiscoveryTableView opportunities={opportunities} workspace={workspace} />);
    const cell = cellEl("opportunity:opp-1", "segment");
    act(() => cell.focus());
    fireEvent.keyDown(cell, { key: "Enter" });
    const input = screen.getByTestId("grid-cell-input");
    fireEvent.change(input, { target: { value: "x".repeat(256) } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("grid-cell-input")).toBeInTheDocument();
  });

  it("shows an editable Description column that saves through the panel route", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <DiscoveryTableView
        opportunities={[{ ...opportunities[0], description: "Users drop off in week one." }]}
        workspace={workspace}
      />,
    );
    const cell = cellEl("opportunity:opp-1", "description");
    expect(cell).toHaveTextContent("Users drop off in week one.");
    act(() => cell.focus());
    fireEvent.keyDown(cell, { key: "Enter" });
    const input = screen.getByTestId("grid-cell-input");
    expect(input).toHaveValue("Users drop off in week one.");
    fireEvent.change(input, { target: { value: "Rewritten" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({
      field: "description",
      value: "Rewritten",
    });
  });

  it("undoes a segment edit by saving the previous value through the same route", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DiscoveryTableView opportunities={opportunities} workspace={workspace} />);
    const cell = cellEl("opportunity:opp-1", "segment");
    act(() => cell.focus());
    fireEvent.keyDown(cell, { key: "Enter" });
    const input = screen.getByTestId("grid-cell-input");
    fireEvent.change(input, { target: { value: "Enterprise" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).toEqual({
      field: "customerSegment",
      value: "New teams",
    });
    await waitFor(() => expect(cellEl("opportunity:opp-1", "segment")).toHaveTextContent("New teams"));
  });

  it("a read-only workspace cannot edit segment or description and has no undo", () => {
    render(
      <DiscoveryTableView
        opportunities={[{ ...opportunities[0], description: "d" }]}
        workspace={{ ...workspace, readOnly: true }}
      />,
    );
    expect(cellEl("opportunity:opp-1", "segment")).toHaveAttribute("aria-readonly", "true");
    expect(cellEl("opportunity:opp-1", "description")).toHaveAttribute("aria-readonly", "true");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("does not add the Description column to the read-only table view", () => {
    render(<DiscoveryTableView opportunities={opportunities} />);
    expect(screen.queryByRole("columnheader", { name: /description/i })).toBeNull();
  });

  it("does not make solution rows editable", () => {
    render(<DiscoveryTableView opportunities={opportunities} workspace={workspace} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand Understand onboarding friction" }));
    expect(cellEl("solution:sol-1", "item")).toHaveAttribute("aria-readonly", "true");
  });

  it("pasting rows creates drafts and Create sends them as opportunity batch items with the same ids on retry", async () => {
    const sent: { clientId: string }[][] = [];
    createOpportunitiesBatch.mockImplementation(async (_org: string, _ws: string, items: { clientId: string }[]) => {
      sent.push(items);
      if (sent.length === 1) throw new Error("network");
      return { ok: true, results: items.map((item) => ({ clientId: item.clientId, ok: true, id: item.clientId })) };
    });
    render(<DiscoveryTableView opportunities={opportunities} workspace={workspace} />);

    paste('Onboarding\tNew teams\tActive\tPlatform\t"Step 1\nStep 2"\r\nReporting\t\t\t\t\r\n');
    expect(screen.getAllByTestId("draft-row")).toHaveLength(2);
    fireEvent.click(screen.getByTestId("draft-create"));

    await waitFor(() => expect(screen.getAllByTestId("draft-row-error")).toHaveLength(2));
    expect(createOpportunitiesBatch).toHaveBeenCalledWith("acme", "product", expect.any(Array));
    expect(sent[0]).toEqual([
      {
        clientId: expect.any(String),
        title: "Onboarding",
        customerSegment: "New teams",
        status: "ACTIVE",
        squadId: "squad-2",
        description: "Step 1\nStep 2",
      },
      {
        clientId: expect.any(String),
        title: "Reporting",
        customerSegment: null,
        status: "EXPLORING",
        squadId: null,
        description: null,
      },
    ]);

    fireEvent.click(screen.getByTestId("draft-create"));
    await waitFor(() => expect(screen.queryAllByTestId("draft-row")).toHaveLength(0));
    expect(sent[1].map((item) => item.clientId)).toEqual(sent[0].map((item) => item.clientId));
  });

  it("shows a server field error on its cell (squadId maps to the Squad field)", async () => {
    createOpportunitiesBatch.mockImplementation(async (_o: string, _w: string, items: { clientId: string }[]) => ({
      ok: true,
      results: items.map((item) => ({
        clientId: item.clientId,
        ok: false,
        code: "NOT_FOUND",
        error: "That squad is not in this workspace.",
        field: "squadId",
      })),
    }));
    render(<DiscoveryTableView opportunities={opportunities} workspace={workspace} />);
    paste("One");
    fireEvent.change(screen.getAllByLabelText(/^Title for/)[0], { target: { value: "One" } });
    fireEvent.click(screen.getByTestId("draft-create"));
    await waitFor(() => expect(screen.getByTestId("draft-field-error")).toHaveTextContent("That squad is not in this workspace."));
    expect(screen.getByLabelText("Squad for opportunity draft 1")).toHaveAttribute("aria-invalid", "true");
  });

  it("flags a title over 255 characters inline without calling the server", async () => {
    render(<DiscoveryTableView opportunities={opportunities} workspace={workspace} />);
    fireEvent.change(screen.getAllByLabelText(/^Title for/)[0], { target: { value: "x".repeat(256) } });
    fireEvent.click(screen.getByTestId("draft-create"));
    await waitFor(() => expect(screen.getByTestId("draft-field-error")).toHaveTextContent(/255 characters/));
    expect(createOpportunitiesBatch).not.toHaveBeenCalled();
  });

  it("hides the draft area and editors when read-only", () => {
    render(<DiscoveryTableView opportunities={opportunities} workspace={{ ...workspace, readOnly: true }} />);
    expect(screen.queryByTestId("grid-draft-area")).not.toBeInTheDocument();
    expect(cellEl("opportunity:opp-1", "item")).toHaveAttribute("aria-readonly", "true");
  });

  it("still offers the draft area when there are no opportunities yet", () => {
    render(<DiscoveryTableView opportunities={[]} workspace={workspace} />);
    expect(screen.getByTestId("grid-draft-area")).toBeInTheDocument();
  });

  it("keeps the dashed empty box for a read-only workspace with no opportunities", () => {
    render(<DiscoveryTableView opportunities={[]} workspace={{ ...workspace, readOnly: true }} />);
    expect(screen.queryByTestId("grid-draft-area")).not.toBeInTheDocument();
    expect(screen.getByText(/match the current filters/)).toBeInTheDocument();
  });

  describe("Add solutions mode", () => {
    const useSolutionsMode = () => fireEvent.click(screen.getByTestId("draft-mode-solutions"));

    it("offers a mode switch and a parent picker with every live opportunity (not only the filtered rows)", () => {
      render(<DiscoveryTableView opportunities={opportunities} workspace={workspace} />);
      expect(screen.getByTestId("draft-mode-opportunities")).toHaveAttribute("aria-pressed", "true");
      useSolutionsMode();
      expect(screen.getByTestId("draft-mode-solutions")).toHaveAttribute("aria-pressed", "true");
      const picker = screen.getByLabelText("Opportunity", { selector: "select" });
      expect(within(picker).getAllByRole("option").map((option) => option.textContent)).toEqual([
        "Choose an opportunity",
        "Understand onboarding friction",
        "Reduce churn",
        "Twin",
        "Twin",
      ]);
    });

    it("sends pasted solutions under the chosen parent, once per batch", async () => {
      createSolutionsBatch.mockImplementation(async (_o: string, _w: string, items: { clientId: string }[]) => ({
        ok: true,
        results: items.map((item) => ({ clientId: item.clientId, ok: true, id: item.clientId })),
      }));
      render(<DiscoveryTableView opportunities={opportunities} workspace={workspace} />);
      useSolutionsMode();
      fireEvent.change(screen.getByLabelText("Opportunity", { selector: "select" }), { target: { value: "opp-2" } });
      paste('Win-back email\t\t"Line 1\nLine 2"\r\nExit survey\r\n', /^Title for solution draft \d+$/);
      expect(screen.getAllByTestId("draft-row")).toHaveLength(2);
      fireEvent.click(screen.getByTestId("draft-create"));
      await waitFor(() => expect(screen.queryAllByTestId("draft-row")).toHaveLength(0));
      expect(createOpportunitiesBatch).not.toHaveBeenCalled();
      expect(createSolutionsBatch).toHaveBeenCalledWith("acme", "product", [
        { clientId: expect.any(String), title: "Win-back email", description: "Line 1\nLine 2", parent: { id: "opp-2" } },
        { clientId: expect.any(String), title: "Exit survey", description: null, parent: { id: "opp-2" } },
      ]);
    });

    it("flags every row inline when no parent is chosen, without calling the server", async () => {
      render(<DiscoveryTableView opportunities={opportunities} workspace={workspace} />);
      useSolutionsMode();
      fireEvent.change(screen.getAllByLabelText(/^Title for solution/)[0], { target: { value: "Orphan" } });
      fireEvent.click(screen.getByTestId("draft-create"));
      await waitFor(() => expect(screen.getByTestId("draft-field-error")).toHaveTextContent(/Choose an opportunity above/));
      expect(createSolutionsBatch).not.toHaveBeenCalled();
    });

    it("matches a pasted Opportunity column by exact title; missing and ambiguous titles are per-row errors", async () => {
      createSolutionsBatch.mockImplementation(async (_o: string, _w: string, items: { clientId: string }[]) => ({
        ok: true,
        results: items.map((item) => ({ clientId: item.clientId, ok: true, id: item.clientId })),
      }));
      render(<DiscoveryTableView opportunities={opportunities} workspace={workspace} />);
      useSolutionsMode();
      paste("Good\tReduce churn\r\nMissing\tReduce chur\r\nAmbiguous\tTwin\r\n", /^Title for solution draft \d+$/);
      fireEvent.click(screen.getByTestId("draft-create"));
      await waitFor(() => expect(screen.getAllByTestId("draft-field-error")).toHaveLength(2));
      const errors = screen.getAllByTestId("draft-field-error").map((node) => node.textContent);
      expect(errors[0]).toMatch(/No opportunity titled "Reduce chur"/);
      expect(errors[1]).toMatch(/2 opportunities are titled "Twin"/);
      // Only the row that resolved was sent.
      expect(createSolutionsBatch).toHaveBeenCalledTimes(1);
      expect(createSolutionsBatch.mock.calls[0][2]).toEqual([
        { clientId: expect.any(String), title: "Good", description: null, parent: { id: "opp-2" } },
      ]);
    });

    it("shows a parent-not-found result from the server on that row", async () => {
      createSolutionsBatch.mockImplementation(async (_o: string, _w: string, items: { clientId: string }[]) => ({
        ok: true,
        results: items.map((item) => ({
          clientId: item.clientId,
          ok: false,
          code: "NOT_FOUND",
          error: "That opportunity was not found in this workspace.",
          field: "parent",
        })),
      }));
      render(<DiscoveryTableView opportunities={opportunities} workspace={workspace} />);
      useSolutionsMode();
      fireEvent.change(screen.getByLabelText("Opportunity", { selector: "select" }), { target: { value: "opp-1" } });
      fireEvent.change(screen.getAllByLabelText(/^Title for solution/)[0], { target: { value: "Gone parent" } });
      fireEvent.click(screen.getByTestId("draft-create"));
      await waitFor(() =>
        expect(screen.getByTestId("draft-field-error")).toHaveTextContent("That opportunity was not found in this workspace."),
      );
      expect(screen.getAllByTestId("draft-row")).toHaveLength(1);
    });

    it("locks the mode switch while drafts exist", () => {
      render(<DiscoveryTableView opportunities={opportunities} workspace={workspace} />);
      fireEvent.change(screen.getAllByLabelText(/^Title for opportunity/)[0], { target: { value: "Draft" } });
      expect(screen.getByTestId("draft-mode-solutions")).toBeDisabled();
      fireEvent.click(screen.getByTestId("draft-discard"));
      expect(screen.getByTestId("draft-mode-solutions")).toBeEnabled();
    });

    it("the Add button in an expanded row switches to Add solutions with that parent preselected", () => {
      render(<DiscoveryTableView opportunities={opportunities} workspace={workspace} />);
      expect(screen.queryByRole("button", { name: /^Add solution to/ })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Expand Understand onboarding friction" }));
      fireEvent.click(screen.getByRole("button", { name: "Add solution to Understand onboarding friction" }));
      expect(screen.getByTestId("draft-mode-solutions")).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByLabelText("Opportunity", { selector: "select" })).toHaveValue("opp-1");
    });

    it("hides the row Add button when read-only", () => {
      render(<DiscoveryTableView opportunities={opportunities} workspace={{ ...workspace, readOnly: true }} />);
      fireEvent.click(screen.getByRole("button", { name: "Expand Understand onboarding friction" }));
      expect(screen.queryByRole("button", { name: /^Add solution to/ })).not.toBeInTheDocument();
    });
  });
});
