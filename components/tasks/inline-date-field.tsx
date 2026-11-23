"use client";

/**
 * Click-to-edit date field — same commit-on-blur/Enter/Escape shape as
 * panel-parts' EditableText, but for a native `<input type="date">` instead
 * of text. Used by TaskDetail for start and due dates.
 */
import { useRef, useState } from "react";
import { patchEntityField, type EditContext } from "@/components/panels/panel-parts";

function toDateInputValue(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

function formatDisplay(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));
}

type Props = {
  value: string | null;
  field: string;
  edit: EditContext;
  placeholder?: string;
  compact?: boolean;
};

export function InlineDateField({ value, field, edit, placeholder, compact = false }: Props) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const ref = useRef<HTMLInputElement | null>(null);
  const label = field === "startDate" ? "Start date" : "Due date";

  const begin = () => { setError(false); setEditing(true); };

  const commit = async () => {
    setEditing(false);
    const raw = ref.current?.value ?? "";
    if (raw === toDateInputValue(value)) return; // unchanged
    setSaving(true);
    try {
      const res = await patchEntityField(
        edit.type,
        edit.id,
        edit.orgSlug,
        edit.workspaceSlug,
        field,
        raw.length > 0 ? raw : null
      );
      edit.onSaved(res.data);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <input
        type="date"
        ref={ref}
        autoFocus
        defaultValue={toDateInputValue(value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commit();
          if (e.key === "Escape") setEditing(false);
        }}
        aria-label={`Edit ${field}`}
        className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
    );
  }

  return (
    <>
    <button
      type="button"
      onClick={begin}
      disabled={saving}
      title="Click to edit"
      aria-label={`${label}: ${value ? formatDisplay(value) : "not set"}`}
      className={`group/edit text-left rounded-md -mx-1 px-1 hover:bg-muted/60 transition-colors ${compact ? "min-h-7 [&>span]:text-xs" : ""} ${saving ? "opacity-60" : ""}`}
    >
      {value ? (
        <span className="text-sm">{formatDisplay(value)}</span>
      ) : (
        <span className="text-sm text-muted-foreground italic">{placeholder ?? "Set a due date…"}</span>
      )}
    </button>
    {error && <span role="alert" className="text-sm text-destructive">Could not save date. The date range may be invalid; check that the start date is on or before the due date, or try again.</span>}
    </>
  );
}
