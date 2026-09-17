"use client";

import { useOptimistic, useRef, useState, useTransition } from "react";
import { CheckIcon, XIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { FieldValuePicker } from "@/components/custom-fields/field-value-picker";
import { upsertFieldValue } from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";
import type { CustomFieldDefinitionData, CustomFieldValue } from "@/lib/types";

interface Props {
  orgSlug: string;
  workspaceSlug: string;
  objectId: string;
  revalidatePathStr: string;
  fields: Array<CustomFieldDefinitionData & { currentValue: CustomFieldValue }>;
  /**
   * Called after a value is written. Server-rendered hosts don't need it —
   * `upsertFieldValue`'s own `revalidatePath` re-renders them with fresh props.
   * A detail panel does: it loads its entity through a client fetch, so nothing
   * about a server revalidation reaches it and the saved value would keep
   * displaying as its pre-save one until the panel was reopened.
   */
  onSaved?: () => void | Promise<unknown>;
}

const PICKLIST_TYPES = ["SELECT", "MULTI_SELECT"] as const;

function isPicklist(
  fieldType: string
): fieldType is (typeof PICKLIST_TYPES)[number] {
  return (PICKLIST_TYPES as readonly string[]).includes(fieldType);
}

// ─── Individual field editor ──────────────────────────────────────────────────

function FieldValue({
  field,
  objectId,
  revalidatePathStr,
  onSaved,
}: {
  field: CustomFieldDefinitionData & { currentValue: CustomFieldValue };
  objectId: string;
  revalidatePathStr: string;
  onSaved?: () => void | Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [localVal, setLocalVal] = useState<string>(
    field.currentValue !== null && field.currentValue !== undefined
      ? Array.isArray(field.currentValue)
        ? (field.currentValue as string[]).join(", ")
        : String(field.currentValue)
      : ""
  );
  const [isPending, startTransition] = useTransition();
  // A picker writes on every pick, so the row must show the new selection
  // before the round trip finishes. The optimistic value is discarded once the
  // transition ends, by which point `onSaved` has been awaited and the host has
  // real data — without that await it would snap back to the stale value and
  // then forward again, one visible flicker per click.
  const [shownValue, showValue] = useOptimistic(field.currentValue);
  // Writes are chained rather than fired in parallel: each one sends the whole
  // selection, so an out-of-order arrival would resurrect a value the user just
  // removed. A rejected link is swallowed here so one failure cannot poison
  // every later write; the awaiting caller still sees its own rejection.
  const writes = useRef<Promise<unknown>>(Promise.resolve());

  function persist(value: CustomFieldValue) {
    startTransition(async () => {
      showValue(value);
      const write = writes.current
        .catch(() => undefined)
        .then(() => upsertFieldValue(objectId, field.id, value, revalidatePathStr));
      writes.current = write;
      await write;
      await onSaved?.();
    });
  }

  function save() {
    let value: CustomFieldValue;
    if (localVal === "") {
      value = null;
    } else if (field.fieldType === "NUMBER") {
      value = parseFloat(localVal) || null;
    } else if (field.fieldType === "BOOLEAN") {
      value = localVal === "true";
    } else {
      value = localVal;
    }

    setEditing(false);
    persist(value);
  }

  const displayValue = shownValue;
  const isEmpty =
    displayValue === null ||
    displayValue === undefined ||
    displayValue === "" ||
    (Array.isArray(displayValue) && (displayValue as string[]).length === 0);

  const label = (
    <span className="text-xs text-muted-foreground w-32 shrink-0 pt-0.5 font-medium">
      {field.name}
      {field.required && <span className="text-red-500 ml-0.5">*</span>}
    </span>
  );

  // A picklist has no separate read and edit modes: its picker shows the
  // current selection and is the control for changing it, so the row never
  // has to be "opened" before a value can be set or removed.
  if (isPicklist(field.fieldType)) {
    return (
      <div className="flex items-start gap-3 py-1.5 group/field">
        {label}
        {/*
          Deliberately not disabled while a write is in flight. Each pick saves
          immediately, so disabling on pending would lock the picker between the
          first and second option of a multi-select. The optimistic value keeps
          the row truthful and `persist` serialises the writes behind it.
        */}
        <FieldValuePicker
          fieldName={field.name}
          fieldType={field.fieldType}
          options={field.options}
          value={shownValue}
          onChange={persist}
        />
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 py-1.5 group/field">
      {label}

      {editing ? (
        <div className="flex items-center gap-1.5 flex-1">
          {field.fieldType === "BOOLEAN" ? (
            <select
              className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm"
              value={localVal}
              onChange={(e) => setLocalVal(e.target.value)}
              disabled={isPending}
              autoFocus
            >
              <option value="">— none —</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          ) : (
            <Input
              className="flex-1 h-7 text-sm"
              value={localVal}
              onChange={(e) => setLocalVal(e.target.value)}
              type={
                field.fieldType === "NUMBER"
                  ? "number"
                  : field.fieldType === "DATE"
                    ? "date"
                    : field.fieldType === "URL"
                      ? "url"
                      : "text"
              }
              disabled={isPending}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") setEditing(false);
              }}
            />
          )}
          <button
            onClick={save}
            disabled={isPending}
            className="text-green-600 hover:text-green-700 disabled:opacity-50"
            aria-label="Save"
          >
            <CheckIcon className="size-4" />
          </button>
          <button
            onClick={() => setEditing(false)}
            disabled={isPending}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Cancel"
          >
            <XIcon className="size-4" />
          </button>
        </div>
      ) : (
        <button
          className="flex-1 text-left text-sm min-h-[1.25rem] rounded px-1 -mx-1 hover:bg-muted/50 transition-colors"
          onClick={() => setEditing(true)}
        >
          {isEmpty ? (
            <span className="text-muted-foreground/50 italic">Empty</span>
          ) : field.fieldType === "URL" ? (
            <a
              href={String(displayValue)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 underline underline-offset-2 hover:text-blue-700"
              onClick={(e) => e.stopPropagation()}
            >
              {String(displayValue)}
            </a>
          ) : field.fieldType === "BOOLEAN" ? (
            <span>{displayValue ? "Yes" : "No"}</span>
          ) : (
            <span>{String(displayValue)}</span>
          )}
        </button>
      )}
    </div>
  );
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export function CustomFieldsPanel({
  fields,
  objectId,
  revalidatePathStr,
  onSaved,
}: Omit<Props, "orgSlug" | "workspaceSlug">) {
  if (fields.length === 0) return null;

  return (
    <div className="flex flex-col gap-0.5">
      {fields.map((field) => (
        <FieldValue
          key={field.id}
          field={field}
          objectId={objectId}
          revalidatePathStr={revalidatePathStr}
          onSaved={onSaved}
        />
      ))}
    </div>
  );
}
