/**
 * Pure key -> action table for `interaction="sheet"`, so the keyboard contract
 * can be unit-tested without a DOM. See the APG data-grid pattern.
 */

export type GridKeyInput = {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
};

export type GridMode = "nav" | "edit";

export type GridKeyAction =
  | { type: "move"; rows: number; cols: number }
  | { type: "moveTo"; target: "rowStart" | "rowEnd" | "gridStart" | "gridEnd" }
  | { type: "page"; direction: 1 | -1 }
  | { type: "tab"; direction: 1 | -1 }
  | { type: "startEdit"; text?: string }
  | { type: "space" }
  | { type: "clear" }
  | { type: "openDetail" }
  | { type: "commit"; move: "down" | "up" | "right" | "left" }
  | { type: "cancel" };

export function resolveGridKey(
  input: GridKeyInput,
  mode: GridMode,
): GridKeyAction | null {
  const { key, shiftKey, altKey, ctrlKey, metaKey } = input;
  const chord = Boolean(ctrlKey || metaKey);

  if (mode === "edit") {
    if (key === "Escape") return { type: "cancel" };
    if (altKey || chord) return null;
    if (key === "Enter") return { type: "commit", move: shiftKey ? "up" : "down" };
    if (key === "Tab") return { type: "commit", move: shiftKey ? "left" : "right" };
    return null;
  }

  switch (key) {
    case "ArrowUp":
      return chord || altKey ? null : { type: "move", rows: -1, cols: 0 };
    case "ArrowDown":
      return chord || altKey ? null : { type: "move", rows: 1, cols: 0 };
    case "ArrowLeft":
      return chord || altKey ? null : { type: "move", rows: 0, cols: -1 };
    case "ArrowRight":
      return chord || altKey ? null : { type: "move", rows: 0, cols: 1 };
    case "Tab":
      return altKey || chord ? null : { type: "tab", direction: shiftKey ? -1 : 1 };
    case "Enter":
      if (altKey) return { type: "openDetail" };
      return chord ? null : { type: "startEdit" };
    case "F2":
      return { type: "startEdit" };
    case " ":
      return chord || altKey ? null : { type: "space" };
    case "Delete":
    case "Backspace":
      return chord || altKey ? null : { type: "clear" };
    case "Home":
      return { type: "moveTo", target: chord ? "gridStart" : "rowStart" };
    case "End":
      return { type: "moveTo", target: chord ? "gridEnd" : "rowEnd" };
    case "PageUp":
      return { type: "page", direction: -1 };
    case "PageDown":
      return { type: "page", direction: 1 };
    default:
      // A single printable character starts an edit that replaces the content.
      // `key.length === 1` excludes named keys ("Shift", "F5"); the modifier
      // check keeps browser and app shortcuts (Ctrl+R, Cmd+K) out of the cell.
      if (key.length === 1 && !chord && !altKey) return { type: "startEdit", text: key };
      return null;
  }
}

export type GridPosition = { row: number; col: number };

export type GridDimensions = {
  rowCount: number;
  colCount: number;
  /** Whether the cell at (row, col) accepts edits. Used by Tab. */
  isEditable: (row: number, col: number) => boolean;
  /** Rows to jump on PageUp / PageDown. */
  pageSize: number;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/**
 * Applies a navigation action. Returns `null` when the action should NOT be
 * consumed: Tab past the last editable cell must leave the grid so it stays one
 * tab stop rather than a keyboard trap.
 */
export function nextPosition(
  from: GridPosition,
  action: Extract<GridKeyAction, { type: "move" | "moveTo" | "page" | "tab" }>,
  grid: GridDimensions,
): GridPosition | null {
  const lastRow = grid.rowCount - 1;
  const lastCol = grid.colCount - 1;
  if (lastRow < 0 || lastCol < 0) return null;

  switch (action.type) {
    case "move":
      return {
        row: clamp(from.row + action.rows, 0, lastRow),
        col: clamp(from.col + action.cols, 0, lastCol),
      };
    case "moveTo":
      switch (action.target) {
        case "rowStart":
          return { row: from.row, col: 0 };
        case "rowEnd":
          return { row: from.row, col: lastCol };
        case "gridStart":
          return { row: 0, col: 0 };
        case "gridEnd":
          return { row: lastRow, col: lastCol };
      }
      return null;
    case "page":
      return {
        row: clamp(from.row + action.direction * grid.pageSize, 0, lastRow),
        col: from.col,
      };
    case "tab": {
      // Row-major scan for the next editable cell in the travel direction.
      const step = action.direction;
      let index = from.row * grid.colCount + from.col + step;
      const end = grid.rowCount * grid.colCount;
      while (index >= 0 && index < end) {
        const row = Math.floor(index / grid.colCount);
        const col = index % grid.colCount;
        if (grid.isEditable(row, col)) return { row, col };
        index += step;
      }
      return null;
    }
  }
}
