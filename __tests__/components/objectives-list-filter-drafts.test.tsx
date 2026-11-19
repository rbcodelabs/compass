// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { ObjectivesList } from "@/components/okrs/objectives-list";
import { OkrFilterProvider } from "@/components/okrs/okr-filter-context";
import { OkrNameFilter } from "@/components/okrs/okr-name-filter";

const { params } = vi.hoisted(() => ({ params: new URLSearchParams() }));

vi.mock("@/app/[orgSlug]/[workspaceSlug]/okrs/actions", () => ({
  addKeyResult: vi.fn(),
  logCheckIn: vi.fn(),
  reorderObjective: vi.fn(),
  reorderKeyResult: vi.fn(),
  updateObjectiveStatus: vi.fn(),
  setObjectiveParentKR: vi.fn(),
  deleteObjective: vi.fn(),
  deleteKeyResult: vi.fn(),
}));
vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  useSearchParams: () => params,
}));
vi.mock("@/components/ui/card-menu", () => ({
  CardMenu: ({ items }: { items: { label: string; onClick: () => void }[] }) =>
    items.map((item) => <button key={item.label} onClick={item.onClick}>{item.label}</button>),
}));

function renderCycle(grouped: boolean) {
  if (grouped) params.set("groupBy", "field:priority");
  render(
    <OkrFilterProvider>
      <OkrNameFilter />
      <ObjectivesList
        orgSlug="org"
        workspaceSlug="workspace"
        cyclePath="/org/workspace/okrs/cycle"
        objectives={["Alpha", "Beta"].map((title) => ({
          id: title,
          title,
          status: "ON_TRACK",
          owner: null,
          keyResults: [{ id: `${title}-kr`, title: `${title} result`, current: 1, target: 10, unit: null }],
          customFields: [{
            id: "priority",
            name: "Priority",
            fieldType: "SELECT",
            objectType: "OBJECTIVE",
            options: [{ value: "first", label: "First" }, { value: "second", label: "Second" }],
            sharedOptionSetId: null,
            sharedOptionSetName: null,
            required: false,
            order: 0,
            currentValue: title === "Alpha" ? "first" : "second",
          }],
        }))}
      />
    </OkrFilterProvider>
  );
  return within(screen.getAllByRole("article")[0]);
}

afterEach(() => {
  cleanup();
  params.delete("groupBy");
});

describe.each([false, true])("filter drafts (grouped=%s)", (grouped) => {
  function hideAlpha() {
    const filter = screen.getByRole("searchbox", { name: /filter objectives by name/i });
    fireEvent.change(filter, { target: { value: "Beta" } });
    expect(screen.queryByRole("button", { name: "Alpha" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Beta" })).toBeVisible();
    expect(screen.getByText("1 of 2")).toBeVisible();
    if (grouped) expect(screen.queryByRole("heading", { name: /First/ })).not.toBeInTheDocument();
    return filter;
  }

  it("restores an unsaved Add key result form after Escape clears the filter", async () => {
    const alpha = renderCycle(grouped);
    fireEvent.click(alpha.getByRole("button", { name: "Add key result" }));
    const title = await alpha.findByLabelText("Title");
    fireEvent.change(title, { target: { value: "Unsaved key result" } });
    fireEvent.change(alpha.getByLabelText("Target"), { target: { value: "42" } });
    fireEvent.change(alpha.getByLabelText("Unit (optional)"), { target: { value: "leads" } });

    const filter = hideAlpha();
    expect(screen.queryByRole("textbox", { name: "Title" })).not.toBeInTheDocument();
    const beta = within(screen.getByRole("article"));
    fireEvent.click(beta.getByRole("button", { name: "Add key result" }));
    const betaTitle = await beta.findByRole("textbox", { name: "Title" });
    fireEvent.change(betaTitle, { target: { value: "Beta draft" } });
    fireEvent.keyDown(filter, { key: "Escape" });

    const restored = within(screen.getAllByRole("article")[0]);
    await waitFor(() => expect(restored.getByLabelText("Title")).toHaveValue("Unsaved key result"));
    expect(restored.getByLabelText("Target")).toHaveValue(42);
    expect(restored.getByLabelText("Unit (optional)")).toHaveValue("leads");
    expect(beta.getByLabelText("Title")).toHaveValue("Beta draft");
  });

  it("restores an unsaved check-in after clicking Clear filter", () => {
    const alpha = renderCycle(grouped);
    fireEvent.click(alpha.getByRole("button", { name: "Check in" }));
    fireEvent.change(alpha.getByLabelText("Current value"), { target: { value: "7" } });
    fireEvent.change(alpha.getByLabelText("Note (optional)"), { target: { value: "Unsaved note" } });

    const filter = hideAlpha();
    expect(screen.queryByRole("spinbutton", { name: "Current value" })).not.toBeInTheDocument();
    const beta = within(screen.getByRole("article"));
    fireEvent.click(beta.getByRole("button", { name: "Check in" }));
    fireEvent.change(beta.getByRole("spinbutton", { name: "Current value" }), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));

    expect(filter).toHaveFocus();
    const restored = within(screen.getAllByRole("article")[0]);
    expect(restored.getByLabelText("Current value")).toHaveValue(7);
    expect(restored.getByLabelText("Note (optional)")).toHaveValue("Unsaved note");
    expect(beta.getByLabelText("Current value")).toHaveValue(3);
  });
});
