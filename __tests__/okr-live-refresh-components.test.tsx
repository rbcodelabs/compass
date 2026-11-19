// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const dnd = vi.hoisted(() => ({ props: null as null | Record<string, (e?: unknown) => void> }));

vi.mock("@dnd-kit/core", async (orig) => {
  const actual = await orig<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: Record<string, unknown> & { children: React.ReactNode }) => {
      dnd.props = props as never;
      return <>{props.children}</>;
    },
  };
});
vi.mock("@dnd-kit/sortable", async (orig) => {
  const actual = await orig<typeof import("@dnd-kit/sortable")>();
  return {
    ...actual,
    SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, setActivatorNodeRef: () => {}, transform: null, transition: undefined, isDragging: false }),
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/o/w/okrs",
}));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/okrs/actions", () => ({
  reorderObjective: vi.fn(),
  reorderKeyResult: vi.fn(),
  deleteKeyResult: vi.fn(),
  setObjectiveParentKR: vi.fn(),
}));
vi.mock("@/components/panels/panel-context", () => ({ usePanelContext: () => ({ openPanel: vi.fn() }) }));
vi.mock("@/components/okrs/check-in-form", () => ({ CheckInForm: () => null }));
vi.mock("@/components/ui/card-menu", () => ({ CardMenu: () => null }));
vi.mock("@/components/okrs/okr-visuals", () => ({ PaceTrack: () => null }));
vi.mock("@/components/ui/combobox", () => ({
  Combobox: ({ items, onValueChange }: { items: Array<{ value: string; label: string }>; onValueChange?: (v: string) => void }) => (
    <ul data-testid="options">{items.map((i) => <li key={i.value}><button type="button" onClick={() => onValueChange?.(i.value)}>{i.label}</button></li>)}</ul>
  ),
  ComboboxContent: () => null,
}));
vi.mock("@/components/okrs/objective-row", async () => {
  const React = await import("react");
  return {
    ObjectiveRow: ({ objective }: { objective: { id: string; title: string } }) => {
      const [draft, setDraft] = React.useState("");
      return (
        <div>
          <span>{objective.title}</span>
          <input aria-label={`draft-${objective.id}`} value={draft} onChange={(e) => setDraft(e.target.value)} />
        </div>
      );
    },
  };
});

import * as actions from "@/app/[orgSlug]/[workspaceSlug]/okrs/actions";
import { ObjectivesList } from "@/components/okrs/objectives-list";
import { KeyResultBar } from "@/components/okrs/key-result-bar";

const obj = (id: string, title = id) => ({ id, title, status: "ON_TRACK" as const, owner: null, keyResults: [] });
const listProps = { orgSlug: "o", workspaceSlug: "w", cyclePath: "/o/w/okrs/c" };

afterEach(() => { cleanup(); dnd.props = null; });

describe("cycle page", () => {
  it("does not key ObjectivesList by the objective id list (which remounts every row on a remote insert)", () => {
    const src = readFileSync(path.join(process.cwd(), "app/[orgSlug]/[workspaceSlug]/okrs/[cycleId]/page.tsx"), "utf8");
    const tag = src.slice(src.indexOf("<ObjectivesList"), src.indexOf("/>", src.indexOf("<ObjectivesList")));
    // Only the cycle identity may key the list (resets state on cycle switch); never the objective ids.
    expect(tag.match(/\bkey=\{[^}]*\}/g) ?? []).toEqual(["key={cycleId}"]);
  });
});

describe("ObjectivesList live refresh", () => {
  // Non-regression guard: passes on the old code too (the remount came from the page key, covered above).
  it("keeps an unrelated row's draft when a remote objective arrives", () => {
    const { rerender } = render(<ObjectivesList {...listProps} objectives={[obj("A")]} />);
    fireEvent.change(screen.getByLabelText("draft-A"), { target: { value: "typed" } });
    rerender(<ObjectivesList {...listProps} objectives={[obj("A"), obj("B")]} />);
    expect(screen.getByText("B")).toBeInTheDocument();
    expect((screen.getByLabelText("draft-A") as HTMLInputElement).value).toBe("typed");
  });

  it("defers adopting refreshed data while a drag is active, and adopts after cancel", () => {
    const { rerender } = render(<ObjectivesList {...listProps} objectives={[obj("A")]} />);
    act(() => dnd.props!.onDragStart());
    rerender(<ObjectivesList {...listProps} objectives={[obj("A"), obj("B")]} />);
    expect(screen.queryByText("B")).toBeNull();
    act(() => dnd.props!.onDragCancel());
    expect(screen.getByText("B")).toBeInTheDocument();
  });
});

describe("SortableKeyResults live refresh", () => {
  it("defers adopting refreshed key results while a drag is active", async () => {
    vi.doUnmock("@/components/okrs/objective-row");
    vi.resetModules();
    const { SortableKeyResults } = await import("@/components/okrs/objective-row");
    const kr = (id: string) => ({ id, title: `KR ${id}`, current: 0, target: 10, unit: null });
    const p = { objectiveId: "o1", orgSlug: "o", workspaceSlug: "w", revalidatePathStr: "/p" };
    const { rerender } = render(<SortableKeyResults {...p} keyResults={[kr("a")]} />);
    act(() => dnd.props!.onDragStart());
    rerender(<SortableKeyResults {...p} keyResults={[kr("a"), kr("b")]} />);
    expect(screen.queryByText("KR b")).toBeNull();
    act(() => dnd.props!.onDragCancel());
    expect(screen.getByText("KR b")).toBeInTheDocument();
  });
});

describe("KeyResultBar supporting data follows props", () => {
  const kr = (supporting: Array<{ id: string; title: string; pct: number }>) => ({
    id: "kr1", title: "Annual KR", current: 1, target: 10, unit: null,
    supportingObjectives: supporting.map((s) => ({
      id: s.id, title: s.title, status: "ON_TRACK" as const, cycle: { id: "c2", title: "Q1" }, squad: null,
      keyResults: [{ current: s.pct, target: 100 }],
    })),
  });
  const opt = (id: string, title: string) => ({ id, title, cycleId: "c2", cycleTitle: "Q1" });
  const base = { objectiveId: "own", orgSlug: "o", workspaceSlug: "w" };

  it("updates support titles/progress and picker options on rerender", () => {
    const opts1 = [opt("s9", "Option nine")];
    const { rerender } = render(<KeyResultBar {...base} keyResult={kr([{ id: "s1", title: "Old name", pct: 30 }])} supportingObjectiveOptions={opts1} />);
    expect(screen.getByText("Old name")).toBeInTheDocument();
    expect(screen.getByText("30%")).toBeInTheDocument();

    rerender(<KeyResultBar {...base} keyResult={kr([{ id: "s1", title: "New name", pct: 60 }])} supportingObjectiveOptions={[opt("s9", "Option nine")]} />);
    expect(screen.getByText("New name")).toBeInTheDocument();
    expect(screen.getByText("60%")).toBeInTheDocument();

    rerender(<KeyResultBar {...base} keyResult={kr([])} supportingObjectiveOptions={[opt("s9", "Option nine"), opt("s1", "New name")]} />);
    expect(screen.queryByText("60%")).toBeNull();
    expect(screen.getByTestId("options")).toHaveTextContent("New name Q1");
  });
});

describe("KeyResultBar link save in flight", () => {
  const kr = (ids: string[]) => ({
    id: "kr1", title: "Annual KR", current: 1, target: 10, unit: null,
    supportingObjectives: ids.map((id) => ({
      id, title: `Sup ${id}`, status: "ON_TRACK" as const, cycle: { id: "c2", title: "Q1" }, squad: null, keyResults: [],
    })),
  });
  const base = { objectiveId: "own", orgSlug: "o", workspaceSlug: "w" };

  it("defers adopting refreshed props while the save is pending, then adopts", async () => {
    let resolve!: () => void;
    vi.mocked(actions.setObjectiveParentKR).mockReturnValue(new Promise<void>((r) => { resolve = r; }) as never);
    const { rerender } = render(<KeyResultBar {...base} keyResult={kr(["s1"])} supportingObjectiveOptions={[]} />);
    await act(async () => { fireEvent.click(screen.getByLabelText("Unlink Sup s1")); });
    expect(screen.queryByText("Sup s1")).toBeNull(); // optimistic
    rerender(<KeyResultBar {...base} keyResult={kr(["s1", "s2"])} supportingObjectiveOptions={[]} />);
    expect(screen.queryByText("Sup s2")).toBeNull(); // deferred
    await act(async () => { resolve(); });
    rerender(<KeyResultBar {...base} keyResult={kr(["s2"])} supportingObjectiveOptions={[]} />);
    expect(screen.getByText("Sup s2")).toBeInTheDocument();
  });

  it("rolls back the optimistic unlink and shows the error when the save fails", async () => {
    vi.mocked(actions.setObjectiveParentKR).mockRejectedValue(new Error("nope"));
    render(<KeyResultBar {...base} keyResult={kr(["s1"])} supportingObjectiveOptions={[]} />);
    await act(async () => { fireEvent.click(screen.getByLabelText("Unlink Sup s1")); });
    expect(screen.getByText("Sup s1")).toBeInTheDocument();
    expect(screen.getByText("nope")).toBeInTheDocument();
  });
});

describe("ObjectiveRow parent key result follows props", () => {
  it("updates the parent chip and unlink state when parentKeyResultId changes while mounted", async () => {
    vi.doUnmock("@/components/okrs/objective-row");
    vi.resetModules();
    const { ObjectiveRow } = await import("@/components/okrs/objective-row");
    const availableKRs = [
      { id: "p1", title: "Parent one", cycleTitle: "FY", cycleId: "c1", objectiveId: "other" },
      { id: "p2", title: "Parent two", cycleTitle: "FY", cycleId: "c1", objectiveId: "other" },
    ] as never;
    const o = { id: "o1", title: "Obj", status: "ON_TRACK" as const, owner: null, keyResults: [] };
    const p = { objective: o, orgSlug: "o", workspaceSlug: "w", availableKRs };
    const { rerender } = render(<ObjectiveRow {...p} parentKeyResultId={null} />);
    expect(screen.queryByText(/Parent one · FY/)).toBeNull();
    rerender(<ObjectiveRow {...p} parentKeyResultId="p1" />);
    expect(screen.getByText(/Parent one · FY/)).toBeInTheDocument();
    rerender(<ObjectiveRow {...p} parentKeyResultId="p2" />);
    expect(screen.getByText(/Parent two · FY/)).toBeInTheDocument();
    rerender(<ObjectiveRow {...p} parentKeyResultId={null} />);
    expect(screen.queryByText(/Parent two · FY/)).toBeNull();
  });
});
