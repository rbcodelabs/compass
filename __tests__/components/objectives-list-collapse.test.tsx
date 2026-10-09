// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/app/[orgSlug]/[workspaceSlug]/okrs/actions", () => ({
  reorderObjective: vi.fn(),
  reorderKeyResult: vi.fn(),
  updateObjectiveStatus: vi.fn(),
  setObjectiveParentKR: vi.fn(),
  deleteObjective: vi.fn(),
  deleteKeyResult: vi.fn(),
  logCheckIn: vi.fn(),
}));
vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel: vi.fn() }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/okrs/add-key-result-form", () => ({ AddKeyResultForm: () => null }));
vi.mock("@/components/custom-fields/custom-fields-panel", () => ({ CustomFieldsPanel: () => null }));
vi.mock("@/components/okrs/check-in-form", () => ({ CheckInForm: () => null }));
vi.mock("@/components/ui/card-menu", () => ({ CardMenu: () => null }));
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: () => null,
  SelectItem: () => null,
  SelectValue: () => null,
}));

import { ObjectivesList } from "@/components/okrs/objectives-list";

const kr = (id: string, title: string) => ({ id, title, current: 1, target: 10, unit: null });
const objectives = [
  { id: "o1", title: "Objective one", status: "ON_TRACK" as const, owner: null, keyResults: [kr("k1", "KR one"), kr("k2", "KR two")] },
  { id: "o2", title: "Objective two", status: "ON_TRACK" as const, owner: null, keyResults: [kr("k3", "KR three")] },
];

function renderList(list = objectives) {
  return render(<ObjectivesList objectives={list} orgSlug="org" workspaceSlug="ws" cyclePath="/org/ws/okrs/c1" />);
}

describe("collapsible objective cards", () => {
  afterEach(cleanup);

  it("starts expanded with no count text", () => {
    renderList();
    const toggle = screen.getByRole("button", { name: "Collapse Objective one" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByText("2 key results")).not.toBeInTheDocument();
  });

  it("collapses one objective, hiding its key results and showing the count", () => {
    renderList();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Objective one" }));

    const toggle = screen.getByRole("button", { name: "Expand Objective one" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const body = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(body).toHaveAttribute("hidden");
    expect(screen.getByText("2 key results")).toBeInTheDocument();

    // The other objective is untouched.
    expect(screen.getByRole("button", { name: "Collapse Objective two" })).toHaveAttribute("aria-expanded", "true");

    // Re-expanding restores it.
    fireEvent.click(toggle);
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)!).not.toHaveAttribute("hidden");
  });

  it("Collapse all / Expand all toggles every objective", () => {
    renderList();
    fireEvent.click(screen.getByRole("button", { name: /^Collapse all/i }));
    expect(screen.getByRole("button", { name: "Expand Objective one" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand Objective two" })).toBeInTheDocument();
    expect(screen.getByText("1 key result")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Expand all/i }));
    expect(screen.getByRole("button", { name: "Collapse Objective one" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse Objective two" })).toBeInTheDocument();
  });

  it("collapsing the last expanded objective flips the bulk control to Expand all", () => {
    renderList();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Objective one" }));
    expect(screen.getByRole("button", { name: /^Collapse all/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Objective two" }));
    expect(screen.getByRole("button", { name: /^Expand all/i })).toBeInTheDocument();
  });

  it("hides the bulk control for a single objective", () => {
    renderList([objectives[0]]);
    expect(screen.queryByRole("button", { name: /(Collapse|Expand) all/i })).not.toBeInTheDocument();
  });
});
