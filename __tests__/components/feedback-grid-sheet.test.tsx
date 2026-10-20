// @vitest-environment jsdom
/**
 * Feedback adopts the sheet grid (`sheet` prop) over its Type and Status
 * selects. The legacy behaviour (always-mounted pickers) stays covered by
 * feedback-grid.test.tsx, which renders the grid without `sheet`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const openPanel = vi.fn();
const updateFeedbackStatus = vi.fn();
const updateFeedbackType = vi.fn();

vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/hooks/use-url-state", () => ({
  useUrlState: () => ({ params: new URLSearchParams(), setAll: vi.fn() }),
}));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/feedback/actions", () => ({
  updateFeedbackStatus: (...args: unknown[]) => updateFeedbackStatus(...args),
  updateFeedbackType: (...args: unknown[]) => updateFeedbackType(...args),
  linkFeedbackToOpportunity: vi.fn(),
}));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/roadmap/actions", () => ({
  promoteFeedbackToRoadmap: vi.fn(),
}));

import { FeedbackGrid } from "@/components/feedback/feedback-grid";
import type { FeedbackRow } from "@/components/feedback/feedback-columns";
import { DEFAULT_FEEDBACK_QUERY } from "@/lib/feedback-query";

const items: FeedbackRow[] = [
  {
    id: "fb-1",
    title: "Export takes too long",
    description: "The CSV export spins for minutes.",
    submitterName: "Ada",
    submitterEmail: "ada@example.com",
    status: "OPEN",
    voteCount: 12,
    type: "BUG",
    opportunityId: null,
    roadmapItem: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    attachments: [],
  },
  {
    id: "fb-2",
    title: "Dark mode for the portal",
    description: null,
    submitterName: null,
    submitterEmail: null,
    status: "UNDER_REVIEW",
    voteCount: 5,
    type: "IDEA",
    opportunityId: null,
    roadmapItem: null,
    createdAt: "2026-09-02T00:00:00.000Z",
    attachments: [],
  },
];

function renderGrid(sheet: { readOnly: boolean } | false = { readOnly: false }) {
  return render(
    <FeedbackGrid
      orgSlug="acme"
      workspaceSlug="product"
      workspaceId="ws-1"
      items={items}
      opportunities={[]}
      total={items.length}
      query={DEFAULT_FEEDBACK_QUERY}
      hasAnyFeedback
      sheet={sheet || undefined}
    />,
  );
}

const cellEl = (rowId: string, col: string) =>
  document.querySelector<HTMLElement>(`[data-row-id="${rowId}"] [data-col="${col}"]`)!;

async function chooseOption(name: string) {
  const option = await screen.findByRole("option", { name });
  await act(async () => {
    fireEvent.pointerDown(option, { pointerId: 1, button: 0, isPrimary: true });
    fireEvent.pointerUp(option, { pointerId: 1, button: 0, isPrimary: true });
    fireEvent.click(option);
  });
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
  window.localStorage.clear();
  updateFeedbackStatus.mockResolvedValue({ ok: true });
  updateFeedbackType.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FeedbackGrid in sheet mode", () => {
  it("renders an ARIA grid whose Type and Status cells are editable", () => {
    renderGrid();
    expect(screen.getByRole("grid")).toBeInTheDocument();
    expect(cellEl("fb-1", "status")).toHaveAttribute("aria-readonly", "false");
    expect(cellEl("fb-1", "type")).toHaveAttribute("aria-readonly", "false");
    // Title and votes have no edit config: they stay read-only cells.
    expect(cellEl("fb-1", "votes")).toHaveAttribute("aria-readonly", "true");
  });

  it("changes a status through the same server action, with the null revalidate path", async () => {
    renderGrid();
    const cell = cellEl("fb-1", "status");
    act(() => cell.focus());
    fireEvent.keyDown(cell, { key: "Enter" });
    await chooseOption("Under review");

    await waitFor(() => expect(updateFeedbackStatus).toHaveBeenCalledTimes(1));
    expect(updateFeedbackStatus).toHaveBeenCalledWith("acme", "product", "fb-1", "UNDER_REVIEW", null);
    expect(cellEl("fb-1", "status")).toHaveTextContent("Under review");
  });

  it("Ctrl+Z puts the previous status back through the same action, and Ctrl+Y re-applies it", async () => {
    renderGrid();
    const cell = cellEl("fb-1", "status");
    act(() => cell.focus());
    fireEvent.keyDown(cell, { key: "Enter" });
    await chooseOption("Under review");
    await waitFor(() => expect(updateFeedbackStatus).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(cellEl("fb-1", "status"), { key: "z", ctrlKey: true });
    await waitFor(() => expect(updateFeedbackStatus).toHaveBeenCalledTimes(2));
    expect(updateFeedbackStatus).toHaveBeenLastCalledWith("acme", "product", "fb-1", "OPEN", null);
    await waitFor(() => expect(cellEl("fb-1", "status")).toHaveTextContent("Open"));

    fireEvent.keyDown(cellEl("fb-1", "status"), { key: "y", ctrlKey: true });
    await waitFor(() => expect(updateFeedbackStatus).toHaveBeenCalledTimes(3));
    expect(updateFeedbackStatus).toHaveBeenLastCalledWith("acme", "product", "fb-1", "UNDER_REVIEW", null);
  });

  it("Alt+Enter opens the feedback panel", () => {
    renderGrid();
    const cell = cellEl("fb-2", "status");
    act(() => cell.focus());
    fireEvent.keyDown(cell, { key: "Enter", altKey: true });
    expect(openPanel).toHaveBeenCalledWith("feedback", "fb-2");
  });

  it("a read-only workspace gets the grid without edit or undo affordances", () => {
    renderGrid({ readOnly: true });
    expect(cellEl("fb-1", "status")).toHaveAttribute("aria-readonly", "true");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    const cell = cellEl("fb-1", "status");
    act(() => cell.focus());
    fireEvent.keyDown(cell, { key: "Enter" });
    expect(screen.queryByRole("option")).toBeNull();
    expect(updateFeedbackStatus).not.toHaveBeenCalled();
  });

  it("without the sheet prop the original always-mounted pickers remain", () => {
    renderGrid(false);
    expect(screen.queryByRole("grid")).toBeNull();
    expect(cellEl("fb-1", "status").querySelector('[role="combobox"]')).not.toBeNull();
  });
});
