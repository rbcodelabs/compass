"use client";

/**
 * Shared building blocks for the entity detail panels, so all eight read as
 * one consistent surface instead of drifting. A generic fetch hook plus a
 * handful of layout primitives (section, field, relation row) — each panel
 * body is then mostly a declarative arrangement of these.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ExternalLinkIcon, ChevronRightIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { usePanelContext, type EntityPanelType } from "./panel-context";

/** The context an editable control needs to persist a change. */
export type EditContext = {
  type: EntityPanelType;
  id: string;
  orgSlug: string;
  workspaceSlug: string;
  /** Replace the panel's data with the server's returned entity. */
  onSaved: (data: unknown) => void;
};

/**
 * Fetch one entity's detail from the scoped panel API. Returns the unwrapped
 * `data` (the API returns `{ type, data }`), an `error` flag, and a `refresh`
 * for post-mutation reloads.
 */
export function useEntityDetail<T>(
  type: EntityPanelType,
  id: string,
  orgSlug: string,
  workspaceSlug: string
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);

  // Refetch without clearing the current data — for post-mutation reloads that
  // shouldn't flash the skeleton.
  const refresh = useCallback(() => {
    return fetch(
      `/api/panels/entity/${type}/${id}?orgSlug=${orgSlug}&workspaceSlug=${workspaceSlug}`
    )
      .then((r) => {
        if (!r.ok) throw new Error("fetch failed");
        return r.json();
      })
      .then((res) => setData(res.data as T))
      .catch(() => setError(true));
  }, [type, id, orgSlug, workspaceSlug]);

  useEffect(() => {
    // Reset to the loading skeleton when the entity changes, then load. Same
    // pattern as the existing opportunity/experiment panels.
    setData(null);
    setError(false);
    refresh();
  }, [refresh]);

  // Replace the panel's data in place — used by inline edits to reflect the
  // server's returned entity without a full reload/skeleton flash.
  return { data, error, refresh, mutate: setData };
}

/**
 * PATCH a single editable field on an entity. Resolves to the refreshed
 * `{ type, data }` on success, or throws on a validation/permission failure so
 * the caller can revert its optimistic update.
 */
export async function patchEntityField(
  type: EntityPanelType,
  id: string,
  orgSlug: string,
  workspaceSlug: string,
  field: string,
  value: unknown
): Promise<{ type: string; data: unknown }> {
  const res = await fetch(
    `/api/panels/entity/${type}/${id}?orgSlug=${orgSlug}&workspaceSlug=${workspaceSlug}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field, value }),
    }
  );
  if (!res.ok) throw new Error("save failed");
  return res.json();
}

export function PanelSkeleton() {
  return (
    <div className="flex flex-col gap-4 px-5 pt-2 animate-pulse">
      <div className="h-4 w-2/3 rounded bg-muted" />
      <div className="h-3 w-full rounded bg-muted" />
      <div className="h-3 w-5/6 rounded bg-muted" />
      <div className="h-3 w-4/6 rounded bg-muted" />
    </div>
  );
}

export function PanelError({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
      Could not load {label}.
    </div>
  );
}

export function PanelContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-5 px-5 pb-8 overflow-y-auto">{children}</div>
  );
}

export function FullPageLink({ href }: { href: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-fit"
    >
      <ExternalLinkIcon className="size-3" />
      Open full page
    </Link>
  );
}

const LABEL_CLASS =
  "text-xs font-semibold uppercase tracking-wider text-muted-foreground";

/**
 * Title block: a status control above the entity title. Read-only by default;
 * pass `edit` to make the title inline-editable, and `statusEdit` to turn the
 * status badge into a persist-on-change dropdown (for entities whose header
 * badge IS their editable enum). `status` is the read-only display used when
 * `statusEdit` is absent.
 */
export function PanelTitle({
  title,
  status,
  edit,
  statusEdit,
}: {
  title: string;
  status?: { value?: string; label: string; className?: string };
  edit?: EditContext;
  statusEdit?: {
    field: string;
    options: readonly string[];
    map: Record<string, StatusOption>;
  };
}) {
  return (
    <div className="flex flex-col gap-2 items-start">
      {edit && statusEdit && status?.value ? (
        <StatusSelect
          value={status.value}
          field={statusEdit.field}
          options={statusEdit.options}
          map={statusEdit.map}
          edit={edit}
        />
      ) : (
        status && (
          <Badge className={status.className ?? "bg-slate-100 text-slate-700"}>
            {status.label}
          </Badge>
        )
      )}
      {edit ? (
        <EditableText
          value={title}
          field="title"
          edit={edit}
          className="text-base font-semibold leading-snug w-full"
        />
      ) : (
        <h2 className="text-base font-semibold leading-snug">{title}</h2>
      )}
    </div>
  );
}

/** A labelled section, optionally with a count next to the label. */
export function Section({
  label,
  count,
  children,
}: {
  label: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <>
      <Separator />
      <div className="flex flex-col gap-2">
        <p className={LABEL_CLASS}>
          {label}
          {typeof count === "number" && count > 0 && (
            <span className="normal-case font-normal"> ({count})</span>
          )}
        </p>
        {children}
      </div>
    </>
  );
}

/** A simple label → value field (no separator; use inside a Section or block). */
export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className={LABEL_CLASS}>{label}</p>
      <div className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap">
        {children}
      </div>
    </div>
  );
}

export type RelationItem = {
  type: EntityPanelType;
  id: string;
  title: string;
  badge?: { label: string; className?: string };
};

/**
 * A clickable list of related entities. Clicking a row opens that entity's
 * own panel (a hop that also updates the URL), which is how you navigate the
 * OST tree from within the panel.
 */
export function RelationList({
  items,
  empty,
}: {
  items: RelationItem[];
  empty: string;
}) {
  const { openPanel } = usePanelContext();
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{empty}</p>;
  }
  return (
    <div className="flex flex-col gap-1">
      {items.map((item) => (
        <button
          key={`${item.type}:${item.id}`}
          type="button"
          onClick={() => openPanel(item.type, item.id)}
          className="group flex items-center gap-2 rounded-md -mx-2 px-2 py-1.5 text-left hover:bg-muted transition-colors"
        >
          {item.badge && (
            <Badge
              className={`${item.badge.className ?? "bg-slate-100 text-slate-600"} shrink-0 text-xs`}
            >
              {item.badge.label}
            </Badge>
          )}
          <span className="text-sm leading-snug flex-1">{item.title}</span>
          <ChevronRightIcon className="size-4 text-muted-foreground/40 group-hover:text-muted-foreground shrink-0" />
        </button>
      ))}
    </div>
  );
}

/**
 * Inline-editable text — a title (single line) or description (multi-line).
 * Click the text to edit; Enter (or Cmd/Ctrl+Enter for multiline) or blur
 * saves, Escape cancels. Optimistically shows the new value, reverting if the
 * PATCH is rejected.
 */
export function EditableText({
  value,
  field,
  edit,
  multiline,
  placeholder,
  className,
}: {
  value: string | null;
  field: string;
  edit: EditContext;
  multiline?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [saving, setSaving] = useState(false);

  const begin = () => {
    setDraft(value ?? "");
    setEditing(true);
  };

  const commit = async () => {
    setEditing(false);
    const next = draft.trim();
    if (next === (value ?? "").trim()) return; // unchanged
    setSaving(true);
    try {
      const res = await patchEntityField(
        edit.type,
        edit.id,
        edit.orgSlug,
        edit.workspaceSlug,
        field,
        next.length > 0 ? next : null
      );
      edit.onSaved(res.data);
    } catch {
      // Rejected (e.g. empty title) — the panel data is unchanged, so nothing
      // to revert; just drop back to display mode.
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    const shared = {
      autoFocus: true,
      value: draft,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        setDraft(e.target.value),
      onBlur: commit,
      placeholder,
      className: `w-full rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring ${className ?? ""}`,
    };
    return multiline ? (
      <textarea
        {...shared}
        rows={4}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void commit();
          if (e.key === "Escape") setEditing(false);
        }}
      />
    ) : (
      <input
        {...shared}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commit();
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }

  const isEmpty = !value || value.trim().length === 0;
  return (
    <button
      type="button"
      onClick={begin}
      disabled={saving}
      title="Click to edit"
      className={`group/edit text-left rounded-md -mx-1 px-1 hover:bg-muted/60 transition-colors ${saving ? "opacity-60" : ""} ${className ?? ""}`}
    >
      {isEmpty ? (
        <span className="text-sm text-muted-foreground italic">
          {placeholder ?? "Add…"}
        </span>
      ) : (
        <span className="whitespace-pre-wrap">{value}</span>
      )}
    </button>
  );
}

export type StatusOption = { label: string; className?: string };

/**
 * A status/horizon dropdown that persists on change. `options` are the raw
 * enum values in display order; `map` gives each its label + badge colors
 * (the same per-entity map the panels already keep for read-only rendering).
 */
export function StatusSelect({
  value,
  field,
  options,
  map,
  edit,
}: {
  value: string;
  field: string;
  options: readonly string[];
  map: Record<string, StatusOption>;
  edit: EditContext;
}) {
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);

  const onChange = async (next: string | null) => {
    if (!next || next === value || pending.current) return;
    pending.current = true;
    setSaving(true);
    try {
      const res = await patchEntityField(
        edit.type,
        edit.id,
        edit.orgSlug,
        edit.workspaceSlug,
        field,
        next
      );
      edit.onSaved(res.data);
    } catch {
      // leave as-is on failure
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };

  return (
    <Select value={value} onValueChange={onChange} disabled={saving}>
      <SelectTrigger
        size="sm"
        className={`w-fit border-0 ${map[value]?.className ?? "bg-slate-100 text-slate-700"}`}
      >
        <span className="text-xs font-medium">{map[value]?.label ?? value}</span>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {map[o]?.label ?? o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
