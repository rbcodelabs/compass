"use client";

import * as React from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type {
  GridCellValue,
  GridEdit,
  GridEditOption,
  GridRowData,
} from "../types";

/** Sentinel for "no one" in a person picker; Select items cannot be null. */
const UNASSIGNED = "__unassigned__";

export type CellEditorProps<TRow extends GridRowData> = {
  edit: GridEdit<TRow>;
  row: TRow;
  draftText: string;
  /** The last commit of this editor failed to parse. */
  error: string | null;
  onDraftChange: (text: string) => void;
  /** A listbox editor (select, person) picked a value. */
  onChoose: (value: GridCellValue) => void;
  /** A listbox editor closed without picking. */
  onDismiss: () => void;
  /** A text editor lost focus. */
  onBlur: () => void;
};

/**
 * The editor mounted in the active cell while it is in edit mode. Keyboard
 * handling for Enter / Tab / Esc lives on the grid body, not here, so every
 * editor shares one contract; this component only owns its own widget.
 *
 * Mounted only while editing (the design's option B): a 50-row page never has
 * more than one input alive, and DOM focus stays on the `<td>` the rest of the
 * time.
 */
export function CellEditor<TRow extends GridRowData>(
  props: CellEditorProps<TRow>,
) {
  const { edit } = props;
  if (edit.kind === "select") {
    return (
      <ListboxEditor
        {...props}
        options={edit.options}
        value={edit.getValue(props.row)}
      />
    );
  }
  if (edit.kind === "person") {
    const options: GridEditOption[] = edit.options.map((option) => ({
      value: option.value,
      label: option.label,
    }));
    if (edit.allowUnassigned) options.unshift({ value: UNASSIGNED, label: "Unassigned" });
    return (
      <ListboxEditor
        {...props}
        options={options}
        value={edit.getValue(props.row) ?? UNASSIGNED}
        mapOut={(value) => (value === UNASSIGNED ? null : value)}
      />
    );
  }
  return <TextEditor {...props} />;
}

function TextEditor<TRow extends GridRowData>({
  edit,
  row,
  draftText,
  error,
  onDraftChange,
  onBlur,
}: CellEditorProps<TRow>) {
  const ref = React.useRef<HTMLInputElement>(null);

  // Focus on mount with the caret at the end, as Sheets does: typing continues
  // after an entry character, and F2 appends to the existing value.
  React.useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, []);

  const inputMode =
    edit.kind === "number" ? (edit.integer ? "numeric" : "decimal") : undefined;
  const placeholder = edit.kind === "date" ? "YYYY-MM-DD" : undefined;

  return (
    <input
      ref={ref}
      type="text"
      inputMode={inputMode}
      placeholder={placeholder}
      maxLength={edit.kind === "text" ? edit.maxLength : undefined}
      value={draftText}
      aria-label={edit.triggerLabel?.(row)}
      aria-invalid={error ? true : undefined}
      title={error ?? undefined}
      data-testid="grid-cell-input"
      onChange={(event) => onDraftChange(event.target.value)}
      onBlur={onBlur}
      className={cn(
        "w-full rounded-sm border border-border bg-background px-1 py-0.5 text-sm outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring",
        error && "border-destructive ring-2 ring-destructive/30",
      )}
    />
  );
}

function ListboxEditor<TRow extends GridRowData>({
  edit,
  row,
  error,
  options,
  value,
  mapOut,
  onChoose,
  onDismiss,
}: CellEditorProps<TRow> & {
  options: readonly GridEditOption[];
  value: string;
  mapOut?: (value: string) => GridCellValue;
}) {
  return (
    <Select
      value={value}
      defaultOpen
      onValueChange={(next) => {
        if (typeof next !== "string") return;
        onChoose(mapOut ? mapOut(next) : next);
      }}
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={edit.triggerLabel?.(row)}
        aria-invalid={error ? true : undefined}
        data-testid="grid-cell-edit"
        className="w-full border-0 bg-transparent px-1"
      >
        <span className="truncate text-xs">
          {options.find((option) => option.value === value)?.label ?? value}
        </span>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.icon}
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
