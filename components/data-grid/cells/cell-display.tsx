"use client";

import { Checkbox } from "@/components/ui/checkbox";
import type { GridCellValue, GridEdit, GridRowData } from "../types";
import { formatCellValue } from "./cell-values";

/**
 * Default read-only rendering of an editable column in sheet mode, used when
 * the column supplies no `cell` of its own. Columns that do (Tasks' badges)
 * keep their own markup and this is never reached.
 */
export function CellDisplay<TRow extends GridRowData>({
  edit,
  row,
  readOnly,
  onToggle,
}: {
  edit: GridEdit<TRow>;
  row: TRow;
  readOnly: boolean;
  onToggle: (next: GridCellValue) => void;
}) {
  switch (edit.kind) {
    case "checkbox":
      return (
        <Checkbox
          checked={edit.getValue(row)}
          disabled={readOnly}
          tabIndex={-1}
          aria-label={edit.triggerLabel?.(row)}
          onCheckedChange={(checked) => onToggle(Boolean(checked))}
        />
      );
    case "url": {
      const href = edit.getValue(row);
      if (!href) return null;
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          tabIndex={-1}
          className="truncate underline underline-offset-2"
        >
          {href}
        </a>
      );
    }
    case "select": {
      const selected = edit.options.find(
        (option) => option.value === edit.getValue(row),
      );
      if (edit.renderTrigger) return <>{edit.renderTrigger(selected, row)}</>;
      return (
        <span className="flex items-center gap-1.5 truncate text-xs">
          {selected?.icon}
          {selected?.label ?? edit.getValue(row)}
        </span>
      );
    }
    default:
      return <span className="truncate">{formatCellValue(edit, row)}</span>;
  }
}
