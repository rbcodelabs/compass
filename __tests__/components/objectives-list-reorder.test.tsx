// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const reorderObjective = vi.fn(async () => {});
const reorderKeyResult = vi.fn(async () => {});

vi.mock("@/app/[orgSlug]/[workspaceSlug]/okrs/actions", () => ({
  reorderObjective: (...a: unknown[]) => reorderObjective(...(a as [])),
  reorderKeyResult: (...a: unknown[]) => reorderKeyResult(...(a as [])),
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

/** jsdom has no layout; give every sortable a vertical slot in document order. */
function stubLayout() {
  return vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const sortable = this.matches('[data-slot="card"], .okx-krow');
    if (!sortable) return new DOMRect(0, 0, 0, 0);
    const all = Array.from(document.querySelectorAll('[data-slot="card"], .okx-krow'));
    const top = all.indexOf(this) * 100;
    return new DOMRect(0, top, 600, 80);
  });
}

async function keyboardDrag(handle: HTMLElement) {
  handle.focus();
  const press = async (key: string) => {
    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent("keydown", { code: key, key, bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  };
  await press("Space");
  await press("ArrowDown");
  await press("Space");
}

describe("OKR drag-to-reorder", () => {
  beforeEach(() => {
    reorderObjective.mockClear();
    reorderKeyResult.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function renderList() {
    return render(
      <ObjectivesList objectives={objectives} orgSlug="org" workspaceSlug="ws" cyclePath="/org/ws/okrs/c1" />
    );
  }

  it("reorders objectives when an objective handle is dragged", async () => {
    stubLayout();
    renderList();
    const handles = screen.getAllByRole("button", { name: "Drag to reorder" });
    // First handle in the DOM belongs to the first objective card.
    const objectiveHandle = handles[0];
    expect(objectiveHandle.closest('[data-slot="card"]')).toHaveTextContent("Objective one");

    await keyboardDrag(objectiveHandle);

    expect(reorderObjective).toHaveBeenCalledTimes(1);
    expect(reorderObjective).toHaveBeenCalledWith("o1", 1, "/org/ws/okrs/c1");
    expect(reorderKeyResult).not.toHaveBeenCalled();
  });

  it("still reorders key results within an objective", async () => {
    stubLayout();
    renderList();
    const krHandle = screen
      .getAllByRole("button", { name: "Drag to reorder" })
      .find((h) => h.closest(".okx-krow")?.textContent?.includes("KR one"))!;

    await keyboardDrag(krHandle);

    expect(reorderKeyResult).toHaveBeenCalledTimes(1);
    expect(reorderKeyResult).toHaveBeenCalledWith("k1", 1, "/org/ws/okrs/c1");
    expect(reorderObjective).not.toHaveBeenCalled();
  });
});
