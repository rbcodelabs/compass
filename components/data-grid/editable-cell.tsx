"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { GridEdit, GridRowData } from "./types";

export type EditableCellProps<TRow extends GridRowData> = {
  row: TRow;
  edit: GridEdit<TRow>;
  /** A write for this row is in flight. */
  pending: boolean;
  /** The last write for this row failed with this message. */
  error?: string;
  onCommit: (next: string) => void;
};

/**
 * An inline-editable cell.
 *
 * Built on `components/ui/select.tsx`, which wraps `@base-ui/react`'s Select.
 * base-ui gives outside-click dismissal, Escape-to-close, focus return and the
 * `aria-expanded` / `role="listbox"` wiring for free — which is exactly why the
 * hand-rolled popovers this replaces are being deleted rather than ported.
 *
 * NOTE: base-ui triggers take `render={<Button/>}`, never Radix's `asChild`.
 * `SelectTrigger` already renders its own button element, so no `render` prop
 * is needed here.
 */
export function EditableCell<TRow extends GridRowData>({
  row,
  edit,
  pending,
  error,
  onCommit,
}: EditableCellProps<TRow>) {
  const value = edit.getValue(row);
  const selected = edit.options.find((option) => option.value === value);
  const disabled = pending || Boolean(edit.isDisabled?.(row));

  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (typeof next !== "string" || next === value) return;
        onCommit(next);
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={edit.triggerLabel?.(row)}
        aria-invalid={error ? true : undefined}
        data-error={error ? "true" : undefined}
        data-pending={pending ? "true" : undefined}
        data-testid="grid-cell-edit"
        className={cn(
          "w-full border-0 bg-transparent px-1",
          error && "ring-3 ring-destructive/20",
          pending && "opacity-60",
        )}
      >
        {edit.renderTrigger ? (
          edit.renderTrigger(selected, row)
        ) : (
          <span className="flex items-center gap-1.5 truncate text-xs">
            {selected?.icon}
            {selected?.label ?? value}
          </span>
        )}
      </SelectTrigger>
      <SelectContent>
        {edit.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.icon}
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
