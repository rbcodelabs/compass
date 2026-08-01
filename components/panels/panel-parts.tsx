"use client";

/**
 * Shared building blocks for the entity detail panels, so all eight read as
 * one consistent surface instead of drifting. A generic fetch hook plus a
 * handful of layout primitives (section, field, relation row) — each panel
 * body is then mostly a declarative arrangement of these.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLinkIcon, ChevronRightIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { usePanelContext, type EntityPanelType } from "./panel-context";

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

  return { data, error, refresh };
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

/** Title block: an optional status badge above the entity title. */
export function PanelTitle({
  title,
  status,
}: {
  title: string;
  status?: { label: string; className?: string };
}) {
  return (
    <div className="flex flex-col gap-2">
      {status && (
        <Badge className={status.className ?? "bg-slate-100 text-slate-700"}>
          {status.label}
        </Badge>
      )}
      <h2 className="text-base font-semibold leading-snug">{title}</h2>
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
