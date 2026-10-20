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

vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel }),
}));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/actions", () => ({
  createOpportunitiesBatch: (...args: unknown[]) => createOpportunitiesBatch(...args),
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
});
