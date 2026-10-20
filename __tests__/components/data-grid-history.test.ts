import { describe, expect, it } from "vitest";

import {
  EMPTY_HISTORY,
  HISTORY_LIMIT,
  describeRevert,
  finishRevert,
  inverseChangeSet,
  planRevert,
  recordChangeSet,
  takeStep,
  type CurrentCell,
} from "@/components/data-grid/interaction/history";
import { resolveGridKey } from "@/components/data-grid/interaction/grid-keymap";
import {
  createChangeSet,
  type GridCellChange,
} from "@/components/data-grid/interaction/range-ops";

const cell = (
  rowId: string,
  prev: GridCellChange["prev"],
  next: GridCellChange["next"],
  status: GridCellChange["status"] = "saved",
): GridCellChange => ({ rowId, columnId: "title", field: "title", prev, next, status });

const step = (...changes: GridCellChange[]) => createChangeSet("paste", changes);

describe("recordChangeSet", () => {
  it("records one step per gesture however many cells it touched", () => {
    const history = recordChangeSet(EMPTY_HISTORY, step(cell("a", "x", "y"), cell("b", "x", "y"), cell("c", "x", "y")));
    expect(history.undo).toHaveLength(1);
    expect(history.undo[0].changes).toHaveLength(3);
  });

  it("keeps only the cells the server accepted", () => {
    const history = recordChangeSet(EMPTY_HISTORY, step(cell("a", "x", "y"), cell("b", "x", "y", "failed")));
    expect(history.undo[0].changes.map((change) => change.rowId)).toEqual(["a"]);
  });

  it("does not record a gesture in which nothing saved", () => {
    const history = recordChangeSet(EMPTY_HISTORY, step(cell("a", "x", "y", "failed")));
    expect(history).toBe(EMPTY_HISTORY);
  });

  it("invalidates redo when a new edit arrives", () => {
    let history = recordChangeSet(EMPTY_HISTORY, step(cell("a", "1", "2")));
    const taken = takeStep(history, "undo")!;
    history = finishRevert(taken.rest, "undo", inverseChangeSet("undo", [{ change: taken.step.changes[0], status: "saved" }]));
    expect(history.redo).toHaveLength(1);

    history = recordChangeSet(history, step(cell("b", "1", "2")));
    expect(history.redo).toHaveLength(0);
    expect(history.undo).toHaveLength(1);
  });

  it("bounds the stack, dropping the oldest step", () => {
    let history = EMPTY_HISTORY;
    for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) {
      history = recordChangeSet(history, step(cell(`r${i}`, "a", "b")));
    }
    expect(history.undo).toHaveLength(HISTORY_LIMIT);
    expect(history.undo[0].changes[0].rowId).toBe("r5");
  });
});

describe("takeStep and finishRevert", () => {
  it("takes the most recent step first", () => {
    let history = recordChangeSet(EMPTY_HISTORY, step(cell("a", "1", "2")));
    history = recordChangeSet(history, step(cell("b", "1", "2")));
    const taken = takeStep(history, "undo")!;
    expect(taken.step.changes[0].rowId).toBe("b");
    expect(taken.rest.undo).toHaveLength(1);
  });

  it("returns null on an empty stack", () => {
    expect(takeStep(EMPTY_HISTORY, "undo")).toBeNull();
    expect(takeStep(EMPTY_HISTORY, "redo")).toBeNull();
  });

  it("moves a reverted step to the other stack and back", () => {
    let history = recordChangeSet(EMPTY_HISTORY, step(cell("a", "old", "new")));

    const undone = takeStep(history, "undo")!;
    history = finishRevert(undone.rest, "undo", inverseChangeSet("undo", [{ change: undone.step.changes[0], status: "saved" }]));
    expect(history.undo).toHaveLength(0);
    // The redo entry is the inverse: it writes `new` back, expecting `old` there.
    expect(history.redo[0].changes[0]).toMatchObject({ prev: "new", next: "old" });

    const redone = takeStep(history, "redo")!;
    history = finishRevert(redone.rest, "redo", inverseChangeSet("redo", [{ change: redone.step.changes[0], status: "saved" }]));
    expect(history.redo).toHaveLength(0);
    expect(history.undo[0].changes[0]).toMatchObject({ prev: "old", next: "new" });
  });

  it("drops a step in which nothing was replayed", () => {
    const history = recordChangeSet(EMPTY_HISTORY, step(cell("a", "old", "new")));
    const taken = takeStep(history, "undo")!;
    const after = finishRevert(taken.rest, "undo", inverseChangeSet("undo", []));
    expect(after.undo).toHaveLength(0);
    expect(after.redo).toHaveLength(0);
  });

  it("files only the cells that saved when a replay partly failed", () => {
    const history = recordChangeSet(EMPTY_HISTORY, step(cell("a", "1", "2"), cell("b", "1", "2")));
    const taken = takeStep(history, "undo")!;
    const [a, b] = taken.step.changes;
    const after = finishRevert(
      taken.rest,
      "undo",
      inverseChangeSet("undo", [
        { change: a, status: "saved" },
        { change: b, status: "failed", error: "nope" },
      ]),
    );
    expect(after.redo[0].changes.map((change) => change.rowId)).toEqual(["a"]);
  });
});

describe("planRevert (the conflict rule)", () => {
  const current = (values: Record<string, CurrentCell>) => (change: GridCellChange) =>
    values[change.rowId] ?? { found: false as const, reason: "missing" as const };

  it("replays a cell that still holds what the step wrote", () => {
    const plan = planRevert(step(cell("a", "old", "new")), current({ a: { found: true, value: "new" } }));
    expect(plan.replay.map((change) => change.rowId)).toEqual(["a"]);
    expect(plan.skipped).toEqual([]);
  });

  it("skips a cell that changed since, and reports it", () => {
    const plan = planRevert(
      step(cell("a", "old", "new"), cell("b", "old", "new")),
      current({ a: { found: true, value: "someone else" }, b: { found: true, value: "new" } }),
    );
    expect(plan.replay.map((change) => change.rowId)).toEqual(["b"]);
    expect(plan.skipped).toEqual([{ change: expect.objectContaining({ rowId: "a" }), reason: "changed" }]);
  });

  it("treats null as a value (a cleared cell that is still cleared is replayed)", () => {
    const plan = planRevert(step(cell("a", "was", null)), current({ a: { found: true, value: null } }));
    expect(plan.replay).toHaveLength(1);
  });

  it("skips cells whose row left the page and cells no longer editable", () => {
    const plan = planRevert(
      step(cell("gone", "o", "n"), cell("locked", "o", "n")),
      current({ locked: { found: false, reason: "readonly" } }),
    );
    expect(plan.replay).toEqual([]);
    expect(plan.skipped.map((skip) => skip.reason)).toEqual(["missing", "readonly"]);
  });
});

describe("describeRevert", () => {
  it("reports the skipped and failed cells", () => {
    const text = describeRevert("undo", {
      restored: 2,
      failed: 1,
      skipped: [
        { change: cell("a", "o", "n"), reason: "changed" },
        { change: cell("b", "o", "n"), reason: "changed" },
        { change: cell("c", "o", "n"), reason: "missing" },
      ],
    });
    expect(text).toBe(
      "Undid 2 cells; 1 could not be saved; 2 cells were skipped because they changed since; 1 cell was skipped: its row is no longer on this page.",
    );
  });

  it("is short when everything was restored", () => {
    expect(describeRevert("redo", { restored: 1, failed: 0, skipped: [] })).toBe("Redid 1 cell.");
  });
});

describe("undo / redo keys", () => {
  it("maps Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z and Ctrl+Y in nav mode", () => {
    expect(resolveGridKey({ key: "z", ctrlKey: true }, "nav")).toEqual({ type: "undo" });
    expect(resolveGridKey({ key: "z", metaKey: true }, "nav")).toEqual({ type: "undo" });
    expect(resolveGridKey({ key: "Z", ctrlKey: true, shiftKey: true }, "nav")).toEqual({ type: "redo" });
    expect(resolveGridKey({ key: "z", metaKey: true, shiftKey: true }, "nav")).toEqual({ type: "redo" });
    expect(resolveGridKey({ key: "y", ctrlKey: true }, "nav")).toEqual({ type: "redo" });
  });

  it("leaves Cmd+Y and a bare z to the browser / type-to-edit", () => {
    expect(resolveGridKey({ key: "y", metaKey: true }, "nav")).toBeNull();
    expect(resolveGridKey({ key: "z" }, "nav")).toEqual({ type: "startEdit", text: "z" });
  });

  it("does not claim the chords while an editor is open (native text undo wins)", () => {
    expect(resolveGridKey({ key: "z", ctrlKey: true }, "edit")).toBeNull();
    expect(resolveGridKey({ key: "y", ctrlKey: true }, "edit")).toBeNull();
  });
});
