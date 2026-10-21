// @vitest-environment jsdom

import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { DataGrid } from "@/components/data-grid/data-grid";
import type {
  GridBatchResult,
  GridColumnDef,
  GridCreation,
  GridDraftSubmitItem,
} from "@/components/data-grid/types";

afterEach(cleanup);

type Row = { id: string; title: string };

const COLUMNS: GridColumnDef<Row>[] = [
  { id: "title", header: "Title", meta: { label: "Title" }, cell: ({ row }) => row.original.title },
];

const okChunk = (chunk: GridDraftSubmitItem[]): GridBatchResult => ({
  ok: true,
  results: chunk.map((item) => ({ clientId: item.clientId, ok: true as const, id: item.clientId })),
});

function makeCreation(overrides: Partial<GridCreation> = {}): GridCreation {
  return {
    fields: [
      { id: "title", label: "Title", kind: "text" },
      { id: "segment", label: "Segment", kind: "text" },
      {
        id: "status",
        label: "Status",
        kind: "select",
        options: [
          { value: "EXPLORING", label: "Exploring" },
          { value: "ACTIVE", label: "Active" },
        ],
      },
    ],
    makeValues: () => ({ title: "", segment: "", status: "EXPLORING" }),
    validate: (values): Record<string, string> => (values.title.trim() ? {} : { title: "Add a title." }),
    submit: vi.fn(async (chunk: GridDraftSubmitItem[]) => okChunk(chunk)),
    limits: { maxItems: 100, maxBytes: 256 * 1024 },
    maxRows: 200,
    noun: { singular: "opportunity", plural: "opportunities" },
    ...overrides,
  };
}

function Harness({ creation, rows, readOnly }: { creation: GridCreation; rows: Row[]; readOnly?: boolean }) {
  return (
    <DataGrid<Row>
      gridId="draft-test"
      columns={COLUMNS}
      rows={rows}
      getRowId={(row) => row.id}
      caption="Things"
      pagination={false}
      toolbar={false}
      readOnly={readOnly}
      creation={creation}
    />
  );
}

const ROWS: Row[] = [{ id: "r1", title: "Existing" }];

function setMobile(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

function paste(text: string, label: RegExp = /^Title for .* draft \d+$/) {
  const target = screen.getAllByLabelText(label).at(-1)!;
  fireEvent.paste(target, { clipboardData: { getData: (type: string) => (type === "text/plain" ? text : "") } });
}

const draftRows = () => screen.queryAllByTestId("draft-row");
const createButton = () => screen.getByTestId("draft-create");

beforeEach(() => setMobile(false));

describe("DataGrid draft area", () => {
  it("renders a blank row and no toolbar actions until something is typed", () => {
    render(<Harness creation={makeCreation()} rows={ROWS} />);
    expect(screen.getByTestId("grid-draft-area")).toBeInTheDocument();
    expect(screen.getByTestId("draft-row-blank")).toBeInTheDocument();
    expect(draftRows()).toHaveLength(0);
    expect(screen.queryByTestId("draft-create")).not.toBeInTheDocument();
  });

  it("typing into the blank row promotes it to a draft and leaves a fresh blank row", () => {
    render(<Harness creation={makeCreation()} rows={ROWS} />);
    fireEvent.change(screen.getByLabelText(/^Title for/), { target: { value: "First" } });
    expect(draftRows()).toHaveLength(1);
    expect(screen.getAllByTestId("draft-row-blank")).toHaveLength(1);
    expect(createButton()).toHaveTextContent("Create 1");
  });

  it("pasting N rows into the blank row makes N drafts (quotes, CRLF, trailing newline, empty cells)", () => {
    render(<Harness creation={makeCreation()} rows={ROWS} />);
    paste('One\tTeams\tActive\r\n"Two, ""quoted"""\t\t\r\nThree\r\n');
    expect(draftRows()).toHaveLength(3);
    expect(screen.getByLabelText("Title for opportunity draft 2")).toHaveValue('Two, "quoted"');
    expect(screen.getByLabelText("Status for opportunity draft 1")).toHaveValue("ACTIVE");
    // An empty status cell keeps the default rather than blanking the select.
    expect(screen.getByLabelText("Status for opportunity draft 2")).toHaveValue("EXPLORING");
    expect(createButton()).toHaveTextContent("Create 3");
  });

  it("leaves a single-cell paste to the input", () => {
    render(<Harness creation={makeCreation()} rows={ROWS} />);
    paste("just one value");
    expect(draftRows()).toHaveLength(0);
  });

  it("starts the paste at the focused column", () => {
    render(<Harness creation={makeCreation()} rows={ROWS} />);
    paste("Teams\tActive", /^Segment for/);
    expect(screen.getByLabelText("Segment for opportunity draft 1")).toHaveValue("Teams");
    expect(screen.getByLabelText("Title for opportunity draft 1")).toHaveValue("");
  });

  it("refuses rows beyond maxRows and says so", () => {
    render(<Harness creation={makeCreation({ maxRows: 2 })} rows={ROWS} />);
    paste("a\nb\nc\nd");
    expect(draftRows()).toHaveLength(2);
    expect(screen.getByTestId("draft-paste-notice")).toHaveTextContent(/2 opportunities of 4/);
  });

  it("creates the drafts, removes created ones, and shows the per-row error on the failed one (partial failure)", async () => {
    const submit = vi.fn(async (chunk: GridDraftSubmitItem[]): Promise<GridBatchResult> => ({
      ok: true,
      results: chunk.map((item) =>
        item.values.title === "Bad"
          ? { clientId: item.clientId, ok: false as const, code: "INVALID", error: "Title is too long.", field: "title" }
          : { clientId: item.clientId, ok: true as const, id: item.clientId },
      ),
    }));
    render(<Harness creation={makeCreation({ submit })} rows={ROWS} />);
    paste("Good one\nBad\nGood two");
    fireEvent.click(createButton());

    await waitFor(() => expect(screen.getByTestId("draft-summary")).toHaveTextContent("Created 2 of 3"));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(draftRows()).toHaveLength(1);
    expect(screen.getByLabelText(/^Title for opportunity draft 1$/)).toHaveValue("Bad");
    expect(screen.getByTestId("draft-field-error")).toHaveTextContent("Title is too long.");
    expect(screen.getByLabelText(/^Title for opportunity draft 1$/)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId("grid-live-region")).toHaveTextContent("Created 2 of 3");
  });

  it("retry after a failed request resends the same ids and creates each exactly once", async () => {
    const sent: string[][] = [];
    let attempt = 0;
    const submit = vi.fn(async (chunk: GridDraftSubmitItem[]): Promise<GridBatchResult> => {
      sent.push(chunk.map((item) => item.clientId));
      attempt += 1;
      if (attempt === 1) throw new Error("network down");
      return okChunk(chunk);
    });
    render(<Harness creation={makeCreation({ submit })} rows={ROWS} />);
    paste("A\nB\nC");
    fireEvent.click(createButton());

    await waitFor(() => expect(screen.getAllByTestId("draft-row-error")).toHaveLength(3));
    expect(screen.getAllByTestId("draft-row-error")[0]).toHaveTextContent("Retry is safe");
    expect(draftRows()).toHaveLength(3);

    fireEvent.click(createButton());
    await waitFor(() => expect(draftRows()).toHaveLength(0));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(new Set(sent[0]).size).toBe(3);
  });

  it("retrying only the failed rows keeps their original ids", async () => {
    const seen: GridDraftSubmitItem[][] = [];
    const submit = vi.fn(async (chunk: GridDraftSubmitItem[]): Promise<GridBatchResult> => {
      seen.push(chunk);
      const first = seen.length === 1;
      return {
        ok: true,
        results: chunk.map((item) =>
          first && item.values.title === "B"
            ? { clientId: item.clientId, ok: false as const, code: "INTERNAL", error: "Could not create this item. Retrying is safe." }
            : { clientId: item.clientId, ok: true as const, id: item.clientId },
        ),
      };
    });
    render(<Harness creation={makeCreation({ submit })} rows={ROWS} />);
    paste("A\nB");
    fireEvent.click(createButton());
    await waitFor(() => expect(draftRows()).toHaveLength(1));
    fireEvent.click(createButton());
    await waitFor(() => expect(draftRows()).toHaveLength(0));
    const idOfB = seen[0].find((item) => item.values.title === "B")!.clientId;
    expect(seen[1]).toEqual([{ clientId: idOfB, values: expect.objectContaining({ title: "B" }) }]);
  });

  it("chunks by item count and aggregates the results into one summary", async () => {
    const calls: number[] = [];
    const submit = vi.fn(async (chunk: GridDraftSubmitItem[]) => {
      calls.push(chunk.length);
      return okChunk(chunk);
    });
    render(<Harness creation={makeCreation({ submit, limits: { maxItems: 2, maxBytes: 1e9 } })} rows={ROWS} />);
    paste("1\n2\n3\n4\n5");
    fireEvent.click(createButton());
    await waitFor(() => expect(screen.getByTestId("draft-summary")).toHaveTextContent("Created 5 opportunities."));
    expect(calls).toEqual([2, 2, 1]);
    expect(draftRows()).toHaveLength(0);
  });

  it("chunks by serialized payload size", async () => {
    const calls: number[] = [];
    const submit = vi.fn(async (chunk: GridDraftSubmitItem[]) => {
      calls.push(chunk.length);
      return okChunk(chunk);
    });
    const big = "x".repeat(2000);
    render(<Harness creation={makeCreation({ submit, limits: { maxItems: 100, maxBytes: 5000 } })} rows={ROWS} />);
    paste([1, 2, 3, 4, 5].map((n) => `${n}\t${big}`).join("\n"));
    fireEvent.click(createButton());
    await waitFor(() => expect(draftRows()).toHaveLength(0));
    expect(calls.reduce((a, b) => a + b, 0)).toBe(5);
    expect(calls.length).toBeGreaterThan(1);
    expect(Math.max(...calls)).toBeLessThanOrEqual(2);
  });

  it("stops after a failed chunk: that chunk is unconfirmed and later rows are marked not sent", async () => {
    let call = 0;
    const submit = vi.fn(async (chunk: GridDraftSubmitItem[]): Promise<GridBatchResult> => {
      call += 1;
      if (call === 2) throw new Error("boom");
      return okChunk(chunk);
    });
    render(<Harness creation={makeCreation({ submit, limits: { maxItems: 1, maxBytes: 1e9 } })} rows={ROWS} />);
    paste("A\nB\nC");
    fireEvent.click(createButton());
    await waitFor(() => expect(screen.getAllByTestId("draft-row-error")).toHaveLength(2));
    expect(submit).toHaveBeenCalledTimes(2);
    expect(draftRows()).toHaveLength(2);
    const messages = screen.getAllByTestId("draft-row-error").map((el) => el.textContent);
    expect(messages[0]).toMatch(/Couldn't confirm/);
    expect(messages[1]).toMatch(/Not sent/);
  });

  it("does not send a draft that fails client validation, but sends the rest", async () => {
    const submit = vi.fn(async (chunk: GridDraftSubmitItem[]) => okChunk(chunk));
    render(<Harness creation={makeCreation({ submit })} rows={ROWS} />);
    paste("Fine\tx\n\tonly segment");
    fireEvent.click(createButton());
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0][0]).toHaveLength(1);
    await waitFor(() => expect(draftRows()).toHaveLength(1));
    expect(screen.getByTestId("draft-field-error")).toHaveTextContent("Add a title.");
  });

  it("Discard removes the drafts", () => {
    render(<Harness creation={makeCreation()} rows={ROWS} />);
    paste("A\nB");
    fireEvent.click(screen.getByTestId("draft-discard"));
    expect(draftRows()).toHaveLength(0);
  });

  it("keeps drafts when the server re-delivers rows (revalidatePath)", () => {
    const creation = makeCreation();
    const { rerender } = render(<Harness creation={creation} rows={ROWS} />);
    paste("A\nB");
    expect(draftRows()).toHaveLength(2);
    rerender(<Harness creation={creation} rows={[...ROWS, { id: "r2", title: "Newly created" }]} />);
    expect(screen.getByText("Newly created")).toBeInTheDocument();
    expect(draftRows()).toHaveLength(2);
    expect(screen.getByLabelText("Title for opportunity draft 1")).toHaveValue("A");
  });

  it("warns before unload while drafts exist", () => {
    render(<Harness creation={makeCreation()} rows={ROWS} />);
    const before = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(false);
    paste("A\nB");
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(true);
  });

  it("is hidden when the grid is read-only", () => {
    render(<Harness creation={makeCreation()} rows={ROWS} readOnly />);
    expect(screen.queryByTestId("grid-draft-area")).not.toBeInTheDocument();
  });

  it("is hidden on mobile", () => {
    setMobile(true);
    render(<Harness creation={makeCreation()} rows={ROWS} />);
    expect(screen.queryByTestId("grid-draft-area")).not.toBeInTheDocument();
  });

  it("is absent without a creation prop", () => {
    render(
      <DataGrid<Row> gridId="no-creation" columns={COLUMNS} rows={ROWS} getRowId={(r) => r.id} caption="Things" pagination={false} toolbar={false} />,
    );
    expect(screen.queryByTestId("grid-draft-area")).not.toBeInTheDocument();
  });

  it("disables Create while a submit is in flight (one in-flight batch)", async () => {
    let release: (value: GridBatchResult) => void = () => {};
    const submit = vi.fn(
      (chunk: GridDraftSubmitItem[]) => new Promise<GridBatchResult>((resolve) => (release = () => resolve(okChunk(chunk)))),
    );
    render(<Harness creation={makeCreation({ submit })} rows={ROWS} />);
    paste("A\nB");
    fireEvent.click(createButton());
    await waitFor(() => expect(createButton()).toBeDisabled());
    fireEvent.click(createButton());
    expect(submit).toHaveBeenCalledTimes(1);
    await act(async () => release({ ok: true, results: [] }));
    await waitFor(() => expect(draftRows()).toHaveLength(0));
  });
});
