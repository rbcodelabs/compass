"use client";

import { XIcon } from "lucide-react";
import {
  Combobox,
  ComboboxContent,
  ComboboxMultiple,
  ComboboxTrigger,
  type ComboboxItemData,
} from "@/components/ui/combobox";
import {
  pickerOptions,
  toStoredOptionValues,
  type PickerOption,
} from "@/lib/shared-field-options";
import { cn } from "@/lib/utils";
import type { CustomFieldValue, SelectOption } from "@/lib/types";

/**
 * The value editor for SELECT and MULTI_SELECT custom fields.
 *
 * It replaces a free-text box that comma-split whatever was typed into it.
 * Options carry a human `label` and a stored `value` slug, so a user shown
 * "ZZ Alpha" typed "ZZ Alpha" and stored a value no option had — filters over
 * that field then returned nothing, with nothing on screen explaining why.
 * Here the label is the only thing ever rendered and the value the only thing
 * ever emitted, which makes that mismatch unrepresentable.
 *
 * `options` is already the field's *effective* list: resolved from its shared
 * option set or its own column at the read boundary in
 * lib/custom-field-definitions.ts, so this component never has to know which.
 */

/** Suffix that marks an option only a stored value proves ever existed. */
const STALE_HINT = "not in this list";

export function FieldOptionBadge({
  option,
  className,
}: {
  option: PickerOption;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        option.stale
          ? "border border-dashed border-border text-muted-foreground italic"
          : "bg-muted",
        className
      )}
      style={option.color ? { backgroundColor: option.color, color: "#fff" } : undefined}
      title={option.stale ? `${option.label} — ${STALE_HINT}` : undefined}
    >
      {option.label}
    </span>
  );
}

function toItem(option: PickerOption): ComboboxItemData {
  return {
    value: option.value,
    // `label` is what Base UI filters the list against, so it stays the plain
    // human string even when `render` decorates it.
    label: option.label,
    render: (
      <span className="flex min-w-0 items-center gap-1.5">
        {option.color && (
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: option.color }}
          />
        )}
        {/*
          A stale entry is muted and italic, not just suffixed. The commonest
          stale value is the *label* of a real option, typed into the free-text
          editor this replaces — so the list routinely shows "ZZ Beta" directly
          above a stale "ZZ Beta", and a small grey suffix is not enough to tell
          which one is the option and which one is the mistake.
        */}
        <span className={cn("truncate", option.stale && "text-muted-foreground italic")}>
          {option.label}
        </span>
        {option.stale && (
          <span className="shrink-0 text-xs text-muted-foreground">· {STALE_HINT}</span>
        )}
      </span>
    ),
  };
}

interface Props {
  fieldName: string;
  fieldType: "SELECT" | "MULTI_SELECT";
  /** The field's effective options. Null for a field that defines none. */
  options: SelectOption[] | null;
  value: CustomFieldValue;
  /** Emits a bare value for SELECT, an array for MULTI_SELECT. */
  onChange: (next: CustomFieldValue) => void;
  disabled?: boolean;
}

export function FieldValuePicker({
  fieldName,
  fieldType,
  options,
  value,
  onChange,
  disabled,
}: Props) {
  const multiple = fieldType === "MULTI_SELECT";
  const selected = toStoredOptionValues(value);
  // Stored values with no matching option are carried into the list rather than
  // filtered out of it. The picker reports its whole selection on every change,
  // so an omitted value would be deleted the moment any other option was
  // touched — silent data loss of exactly the legacy rows this change exists to
  // rescue.
  const available = pickerOptions(options, selected);
  const byValue = new Map(available.map((option) => [option.value, option]));
  const items = available.map(toItem);

  const trigger = (
    <ComboboxTrigger
      aria-label={fieldName}
      className="h-auto min-h-6 w-full justify-start gap-1 border-0 bg-transparent px-1 py-0.5 shadow-none hover:bg-muted/50 focus-visible:ring-0 dark:bg-transparent dark:hover:bg-muted/50"
    >
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-left">
        {selected.length === 0 ? (
          <span className="text-sm text-muted-foreground/50 italic">Empty</span>
        ) : (
          selected.map((optionValue) => (
            <FieldOptionBadge
              key={optionValue}
              option={byValue.get(optionValue) ?? { label: optionValue, value: optionValue, stale: true }}
            />
          ))
        )}
      </span>
    </ComboboxTrigger>
  );

  const content = (
    <ComboboxContent
      align="start"
      inputPlaceholder={`Search ${fieldName}…`}
      emptyMessage="No matching options."
    />
  );

  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5">
      {multiple ? (
        <ComboboxMultiple
          items={items}
          values={selected}
          onValuesChange={onChange}
          disabled={disabled}
        >
          {trigger}
          {content}
        </ComboboxMultiple>
      ) : (
        <Combobox
          items={items}
          value={selected[0] ?? null}
          onValueChange={onChange}
          disabled={disabled}
        >
          {trigger}
          {content}
        </Combobox>
      )}
      {selected.length > 0 && (
        <button
          type="button"
          aria-label={`Clear ${fieldName}`}
          disabled={disabled}
          onClick={() => onChange(multiple ? [] : null)}
          className="shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground disabled:opacity-50"
        >
          <XIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}
