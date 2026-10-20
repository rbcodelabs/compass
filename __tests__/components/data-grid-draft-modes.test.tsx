// @vitest-environment jsdom

import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { DataGrid } from "@/components/data-grid/data-grid";
import type {
  GridColumnDef,
  GridCreation,
  GridCreationMode,
  GridCreationRequest,
  GridDraftSubmitItem,
} from "@/components/data-grid/types";

afterEach(cleanup);

type Row = { id: string; title: string };
const COLUMNS: GridColumnDef<Row>[] = [
  { id: "title", header: "Title", meta: { label: "Title" }, cell: ({ row }) => row.original.title },
];

function creation(noun: { singular: string; plural: string }, over: Partial<GridCreation> = {}): GridCreation {
  return {
    fields: [{ id: "title", label: "Title", kind: "text" }],
    makeValues: () => ({ title: "" }),
    validate: (values): Record<string, string> => (values.title.trim() ? {} : { title: "Add a title." }),
    submit: vi.fn(async (items: GridDraftSubmitItem[]) => ({
      ok: true as const,
      results: items.map((item) => ({ clientId: item.clientId, ok: true as const, id: item.clientId })),
    })),
    limits: { maxItems: 100, maxBytes: 256 * 1024 },
    maxRows: 200,
    noun,
    ...over,
  };
}

const solutionsSubmit = vi.fn(async (items: GridDraftSubmitItem[]) => ({
  ok: true as const,
  results: items.map((item) => ({ clientId: item.clientId, ok: true as const, id: item.clientId })),
}));

const MODES: GridCreationMode[] = [
  { id: "things", label: "Add things", creation: creation({ singular: "thing", plural: "things" }) },
  {
    id: "parts",
    label: "Add parts",
    creation: creation(
      { singular: "part", plural: "parts" },
      {
        submit: solutionsSubmit,
        parent: {
          label: "Thing",
          placeholder: "Choose a thing",
          options: [
            { value: "t1", label: "One" },
            { value: "t2", label: "Two" },
          ],
        },
      },
    ),
  },
];

function Harness({ request, readOnly }: { request?: GridCreationRequest; readOnly?: boolean }) {
  return (
    <DataGrid<Row>
      gridId="modes-test"
      columns={COLUMNS}
      rows={[{ id: "r1", title: "Existing" }]}
      getRowId={(row) => row.id}
      caption="Things"
      pagination={false}
      toolbar={false}
      readOnly={readOnly}
      creationModes={MODES}
      creationRequest={request}
    />
  );
}

beforeEach(() => {
  solutionsSubmit.mockClear();
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

describe("draft area modes", () => {
  it("starts in the first mode and switches by button", () => {
    render(<Harness />);
    expect(screen.getByLabelText("New things", { selector: "[role=table]" })).toBeInTheDocument();
    expect(screen.queryByTestId("draft-parent")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("draft-mode-parts"));
    expect(screen.getByLabelText("New parts", { selector: "[role=table]" })).toBeInTheDocument();
    expect(screen.getByTestId("draft-parent")).toBeInTheDocument();
  });

  it("locks the switch while a draft exists and unlocks after discard", () => {
    render(<Harness />);
    fireEvent.change(screen.getAllByLabelText(/^Title for thing/)[0], { target: { value: "x" } });
    expect(screen.getByTestId("draft-mode-parts")).toBeDisabled();
    fireEvent.click(screen.getByTestId("draft-discard"));
    expect(screen.getByTestId("draft-mode-parts")).toBeEnabled();
  });

  it("injects the chosen parent as values.parent into validate and submit", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("draft-mode-parts"));
    fireEvent.change(screen.getByTestId("draft-parent"), { target: { value: "t2" } });
    fireEvent.change(screen.getAllByLabelText(/^Title for part/)[0], { target: { value: "bolt" } });
    fireEvent.click(screen.getByTestId("draft-create"));
    await waitFor(() => expect(solutionsSubmit).toHaveBeenCalledTimes(1));
    expect(solutionsSubmit).toHaveBeenCalledWith([{ clientId: expect.any(String), values: { title: "bolt", parent: "t2" } }]);
  });

  it("keeps the chosen parent when switching modes back and forth", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("draft-mode-parts"));
    fireEvent.change(screen.getByTestId("draft-parent"), { target: { value: "t1" } });
    fireEvent.click(screen.getByTestId("draft-mode-things"));
    fireEvent.click(screen.getByTestId("draft-mode-parts"));
    expect(screen.getByTestId("draft-parent")).toHaveValue("t1");
  });

  it("a request switches the mode, preselects the parent and focuses the blank row", () => {
    const { rerender } = render(<Harness />);
    rerender(<Harness request={{ modeId: "parts", parentId: "t2", nonce: 1 }} />);
    expect(screen.getByTestId("draft-mode-parts")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("draft-parent")).toHaveValue("t2");
    expect(screen.getAllByLabelText(/^Title for part/).at(-1)).toHaveFocus();
  });

  it("a request does not switch away from unsaved drafts", () => {
    const { rerender } = render(<Harness />);
    fireEvent.change(screen.getAllByLabelText(/^Title for thing/)[0], { target: { value: "x" } });
    rerender(<Harness request={{ modeId: "parts", parentId: "t1", nonce: 1 }} />);
    expect(screen.getByTestId("draft-mode-things")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByTestId("draft-row")).toHaveLength(1);
  });

  it("shows nothing when read-only", () => {
    render(<Harness readOnly />);
    expect(screen.queryByTestId("grid-draft-area")).not.toBeInTheDocument();
  });
});
