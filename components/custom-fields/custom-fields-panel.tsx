"use client";

import { useState, useTransition } from "react";
import { PlusIcon, CheckIcon, XIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { upsertFieldValue } from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";
import type {
  CustomFieldDefinitionData,
  CustomFieldValue,
  SelectOption,
} from "@/lib/types";

interface Props {
  orgSlug: string;
  workspaceSlug: string;
  objectId: string;
  revalidatePathStr: string;
  fields: Array<CustomFieldDefinitionData & { currentValue: CustomFieldValue }>;
}

// ─── Individual field editor ──────────────────────────────────────────────────

function FieldValue({
  field,
  objectId,
  revalidatePathStr,
}: {
  field: CustomFieldDefinitionData & { currentValue: CustomFieldValue };
  objectId: string;
  revalidatePathStr: string;
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

  function save() {
    let value: CustomFieldValue;
    if (localVal === "") {
      value = null;
    } else if (field.fieldType === "NUMBER") {
      value = parseFloat(localVal) || null;
    } else if (field.fieldType === "BOOLEAN") {
      value = localVal === "true";
    } else if (field.fieldType === "MULTI_SELECT") {
      value = localVal
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      value = localVal;
    }

    startTransition(async () => {
      await upsertFieldValue(objectId, field.id, value, revalidatePathStr);
      setEditing(false);
    });
  }

  const displayValue = field.currentValue;
  const isEmpty =
    displayValue === null ||
    displayValue === undefined ||
    displayValue === "" ||
    (Array.isArray(displayValue) && (displayValue as string[]).length === 0);

  return (
    <div className="flex items-start gap-3 py-1.5 group/field">
      <span className="text-xs text-muted-foreground w-32 shrink-0 pt-0.5 font-medium">
        {field.name}
        {field.required && <span className="text-red-500 ml-0.5">*</span>}
      </span>

      {editing ? (
        <div className="flex items-center gap-1.5 flex-1">
          {field.fieldType === "SELECT" ? (
            <select
              className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm"
              value={localVal}
              onChange={(e) => setLocalVal(e.target.value)}
              disabled={isPending}
              autoFocus
            >
              <option value="">— none —</option>
              {((field.options as SelectOption[]) ?? []).map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          ) : field.fieldType === "BOOLEAN" ? (
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
          ) : field.fieldType === "SELECT" ? (
            (() => {
              const opt = ((field.options as SelectOption[]) ?? []).find(
                (o) => o.value === displayValue
              );
              return (
                <span
                  className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-muted"
                  style={opt?.color ? { backgroundColor: opt.color, color: "#fff" } : undefined}
                >
                  {opt?.label ?? String(displayValue)}
                </span>
              );
            })()
          ) : field.fieldType === "MULTI_SELECT" ? (
            <span className="flex flex-wrap gap-1">
              {(displayValue as string[]).map((v) => {
                const opt = ((field.options as SelectOption[]) ?? []).find(
                  (o) => o.value === v
                );
                return (
                  <span
                    key={v}
                    className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-muted"
                    style={opt?.color ? { backgroundColor: opt.color, color: "#fff" } : undefined}
                  >
                    {opt?.label ?? v}
                  </span>
                );
              })}
            </span>
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
        />
      ))}
    </div>
  );
}
