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
import { MarkdownContent } from "@/components/markdown-content";
import { Separator } from "@/components/ui/separator";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  panelSectionStateKey,
  readPanelSectionState,
  writePanelSectionOpen,
} from "@/lib/panel-section-state";
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
          <Badge className={status.className ?? "bg-surface-inset text-text-secondary"}>
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

/**
 * A labelled section, optionally with a count next to the label.
 *
 * Non-collapsible by default: every panel that has not opted in renders
 * exactly the markup it always did. Pass `collapsible` (plus the owning
 * `panelType`) to turn the label row into a disclosure trigger. `defaultOpen`
 * is the first-visit state only — once a reader toggles a section, the stored
 * preference wins on every later visit. The per-type open/closed policy lives
 * at the composition sites, not here.
 */
export function Section({
  label,
  count,
  collapsible = false,
  defaultOpen = false,
  panelType,
  empty = false,
  children,
}: {
  label: string;
  count?: number;
  collapsible?: boolean;
  defaultOpen?: boolean;
  /** Namespaces the persisted state; required when `collapsible`. */
  panelType?: EntityPanelType;
  /** Nothing to show and nothing to do — renders shut with a dead trigger. */
  empty?: boolean;
  children: React.ReactNode;
}) {
  const storageKey = panelSectionStateKey(panelType ?? "panel", label);

  // Resolved while rendering, not in an effect, so the first paint is already
  // correct — see the note in lib/panel-section-state.ts.
  const [open, setOpen] = useState(() =>
    collapsible ? readPanelSectionState()[storageKey] ?? defaultOpen : true
  );

  const labelContent = (
    <>
      {label}
      {typeof count === "number" && count > 0 && (
        <span className="normal-case font-normal"> ({count})</span>
      )}
    </>
  );

  if (!collapsible) {
    return (
      <>
        <Separator />
        <div className="flex flex-col gap-2">
          <p className={LABEL_CLASS}>{labelContent}</p>
          {children}
        </div>
      </>
    );
  }

  return (
    <>
      <Separator />
      <Collapsible
        className="group flex flex-col gap-2"
        open={empty ? false : open}
        disabled={empty}
        onOpenChange={(next) => {
          setOpen(next);
          writePanelSectionOpen(storageKey, next);
        }}
      >
        <CollapsibleTrigger
          /* Base UI marks a disabled disclosure with data-disabled (and keeps
             it focusable) rather than setting the native disabled attribute,
             so the dimmed state keys off that. */
          className={`${LABEL_CLASS} flex w-full items-center gap-1.5 text-left transition-colors hover:text-foreground data-disabled:cursor-default data-disabled:opacity-50 data-disabled:hover:text-muted-foreground`}
        >
          <ChevronRightIcon className="size-3 shrink-0 transition-transform group-data-open:rotate-90" />
          <span>{labelContent}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>{children}</CollapsibleContent>
      </Collapsible>
    </>
  );
}

/** A simple label → value field (no separator; use inside a Section or block). */
export function Field({
  label,
  children,
  layout = "stacked",
}: {
  label: string;
  children: React.ReactNode;
  layout?: "stacked" | "row";
}) {
  return (
    <div className={layout === "row" ? "grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] items-start gap-3 py-1.5" : "flex flex-col gap-1"}>
      <p className={layout === "row" ? "text-xs font-medium text-muted-foreground pt-1" : LABEL_CLASS}>{label}</p>
      <div className={`${layout === "row" ? "min-w-0 break-words " : ""}text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap`}>
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
          /* items-start, not items-center: relation titles routinely wrap to
             two or three lines at panel width, and centering left the badge
             and chevron floating against the middle of the text block. */
          className="group flex items-start gap-2 rounded-md -mx-2 px-2 py-1.5 text-left hover:bg-muted transition-colors"
        >
          {item.badge && (
            <Badge
              className={`${item.badge.className ?? "bg-surface-inset text-text-secondary"} shrink-0 text-xs`}
            >
              {item.badge.label}
            </Badge>
          )}
          {/* min-w-0 so a long title wraps inside the flex row instead of
              forcing the row wider than the panel. */}
          <span className="min-w-0 flex-1 text-sm leading-snug">{item.title}</span>
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
  type = "text",
}: {
  value: string | null;
  field: string;
  edit: EditContext;
  multiline?: boolean;
  placeholder?: string;
  className?: string;
  /** "number" renders a numeric input and sends a parsed number (or null) to
   * the server instead of a raw string — used by task story points. The
   * other 8 panels never pass this, so they're unaffected. */
  type?: "text" | "number";
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  // Uncontrolled input read via ref: commit takes the field's *actual* value
  // at commit time rather than a `draft` state snapshot. Reading state would
  // race when the value arrives all at once and Enter follows immediately —
  // a paste-then-Enter, or a programmatic fill — because React may not have
  // re-rendered the new draft into the commit closure yet.
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  const begin = () => setEditing(true);

  const commit = async () => {
    setEditing(false);
    const raw = (ref.current?.value ?? "").trim();
    if (raw === (value ?? "").trim()) return; // unchanged

    let next: string | number | null;
    if (type === "number") {
      if (raw.length === 0) {
        next = null;
      } else {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) return; // invalid — drop back to display mode, nothing to save
        next = parsed;
      }
    } else {
      next = raw.length > 0 ? raw : null;
    }

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
      // Rejected (e.g. empty title) — the panel data is unchanged, so nothing
      // to revert; just drop back to display mode.
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    const shared = {
      autoFocus: true,
      defaultValue: value ?? "",
      onBlur: commit,
      placeholder,
      "aria-label": `Edit ${field}`,
      className: `w-full rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring ${className ?? ""}`,
    };
    return multiline ? (
      <textarea
        {...shared}
        ref={ref as React.RefObject<HTMLTextAreaElement>}
        rows={4}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void commit();
          if (e.key === "Escape") setEditing(false);
        }}
      />
    ) : (
      <input
        {...shared}
        type={type === "number" ? "number" : "text"}
        ref={ref as React.RefObject<HTMLInputElement>}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commit();
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }

  const isEmpty = !value || value.trim().length === 0;
  if (multiline) return (
    <div className={`group/edit relative min-w-0 rounded-md -mx-1 px-1 pr-9 ${saving ? "opacity-60" : ""} ${className ?? ""}`}>
      {isEmpty ? <span className="text-sm text-muted-foreground italic">{placeholder ?? "Add…"}</span> : <MarkdownContent>{value}</MarkdownContent>}
      <button type="button" onClick={begin} disabled={saving} aria-label={`Edit ${field}`} className="absolute right-1 top-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">Edit</button>
    </div>
  );
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
  label,
}: {
  value: string;
  field: string;
  options: readonly string[];
  map: Record<string, StatusOption>;
  edit: EditContext;
  label?: string;
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
        aria-label={label}
        size="sm"
        className={`w-fit border-0 ${map[value]?.className ?? "bg-surface-inset text-text-secondary"}`}
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
