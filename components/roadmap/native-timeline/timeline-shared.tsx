"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { CalendarDays, ChevronLeft, ChevronRight, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { RoadmapCardData } from "../roadmap-card";
import { isInternalTimelineDestination, type CalendarDate, type TimelineZoom } from "./timeline-model";
import { usePanelContext } from "@/components/panels/panel-context";
import { ROADMAP_DELIVERY_STATUS_LABELS } from "@/lib/roadmap-delivery-status";
import { HORIZON_META } from "@/lib/roadmap";
import type { Horizon } from "@/lib/types";

const EDITABLE_HORIZONS: readonly Horizon[] = ["NOW", "NEXT", "LATER", "SHIPPED"];

export type TimelineEngineProps = {
  items: RoadmapCardData[];
  squads: Array<{ id: string; name: string; color: string }>;
  workspaceId: string;
  unscheduledItems: import("../unscheduled-items-panel").UnscheduledItem[];
  // Gates the LAUNCHING/LAUNCHED horizon rows. Any item still in a launch
  // horizon while this is off folds into the SHIPPED row rather than
  // disappearing — see internalBucketFor in lib/roadmap.ts. Optional and
  // defaults to true (today's unrestricted behavior) so existing tests that
  // don't pass it are unaffected; real page call sites always pass the
  // workspace's actual flag explicitly.
  launchWorkflowEnabled?: boolean;
};

export function TimelineToolbar({
  zoom,
  onZoom,
  onShift,
  onToday,
  engineLabel,
}: {
  zoom: TimelineZoom;
  onZoom: (zoom: TimelineZoom) => void;
  onShift: (direction: -1 | 1) => void;
  onToday: () => void;
  engineLabel: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-3 py-2 shadow-sm">
      <div>
        <p className="text-sm font-semibold text-foreground">{engineLabel}</p>
        <p className="text-xs text-muted-foreground">Dates are inclusive</p>
      </div>
      <div className="flex items-center gap-1" aria-label="Timeline controls">
        <Button type="button" size="icon-sm" variant="outline" aria-label="Previous" onClick={() => onShift(-1)}>
          <ChevronLeft />
        </Button>
        <Button type="button" size="sm" variant="outline" aria-label="Today" onClick={onToday}>
          Today
        </Button>
        <Button type="button" size="icon-sm" variant="outline" aria-label="Next" onClick={() => onShift(1)}>
          <ChevronRight />
        </Button>
        {(["month", "quarter"] as const).map((value) => (
          <Button
            key={value}
            type="button"
            size="sm"
            variant={zoom === value ? "default" : "outline"}
            className={zoom === value ? "bg-primary text-primary-foreground hover:bg-primary/80" : undefined}
            aria-label={value === "month" ? "Month" : "Quarter"}
            aria-pressed={zoom === value}
            onClick={() => onZoom(value)}
          >
            {value === "month" ? "Month" : "Quarter"}
          </Button>
        ))}
      </div>
    </div>
  );
}

export function TimelineCard({
  item,
  start,
  end,
  onOpen,
  onEditDates,
  overlapCount = 1,
  groupBadge = null,
  children,
  className = "",
  editControlClassName = "mr-1",
  editable = true,
}: {
  item: RoadmapCardData;
  start: CalendarDate;
  end: CalendarDate;
  onOpen: () => void;
  onEditDates: () => void;
  overlapCount?: number;
  /** The active custom-field grouping's value for this item, if any — shown as a small pill so grouping by a custom field stays legible per card. */
  groupBadge?: { label: string; color: string | null } | null;
  children?: ReactNode;
  className?: string;
  editControlClassName?: string;
  editable?: boolean;
}) {
  return (
    <div
      data-testid={`timeline-item-${item.id}`}
      data-start={start}
      data-end={end}
      className={`group @container/timeline-card relative flex h-9 min-w-0 items-center overflow-hidden rounded-lg border border-white/40 text-xs font-medium text-white shadow-sm transition-shadow motion-reduce:transition-none hover:shadow-md focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 ${className}`}
      style={{ backgroundColor: ACCESSIBLE_HORIZON_COLORS[item.horizon] }}
      title={`${item.title}: ${start} through ${end}`}
    >
      {children}
      <span
        role="button"
        tabIndex={0}
        aria-label={`Open details for ${item.title}, ${start} through ${end}${overlapCount > 1 ? `, overlaps ${overlapCount - 1} other ${overlapCount === 2 ? "item" : "items"}` : ""}, Delivery status: ${ROADMAP_DELIVERY_STATUS_LABELS[item.deliveryStatus]}`}
        className="flex min-w-0 flex-1 items-center gap-1 self-stretch overflow-hidden px-2 text-left outline-none"
        onClick={onOpen}
        onKeyDown={(event: KeyboardEvent<HTMLSpanElement>) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen();
          }
        }}
      >
        {item.isPrivate ? <Lock className="size-3 shrink-0" aria-label="Private" /> : null}
        <span className="hidden shrink-0 rounded-full border border-white/50 px-1.5 py-0.5 text-[10px] text-white min-[900px]:@[240px]/timeline-card:inline-flex" aria-label={`Delivery status: ${ROADMAP_DELIVERY_STATUS_LABELS[item.deliveryStatus]}`}>
          {ROADMAP_DELIVERY_STATUS_LABELS[item.deliveryStatus]}
        </span>
        <span data-timeline-title className="min-w-0 flex-1 truncate">{item.title}</span>
        {groupBadge ? (
          <span className="hidden shrink-0 items-center gap-1 rounded-full border border-white/50 px-1.5 py-0.5 text-[10px] text-white @[160px]/timeline-card:inline-flex" aria-label={`${groupBadge.label} (grouping field)`}>
            {groupBadge.color ? <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: groupBadge.color }} /> : null}
            {groupBadge.label}
          </span>
        ) : null}
        {overlapCount > 1 ? <span className="hidden shrink-0 rounded border border-white/60 px-1 text-[10px] @[240px]/timeline-card:inline-flex">{overlapCount} overlapping</span> : null}
      </span>
      {editable ? <button
        type="button"
        className={`inline-flex size-6 shrink-0 items-center justify-center rounded bg-white/20 opacity-0 transition-opacity motion-reduce:transition-none hover:bg-white/30 focus:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 ${editControlClassName}`}
        aria-label={`Edit dates for ${item.title}`}
        onClick={(event) => {
          event.stopPropagation();
          onEditDates();
        }}
      >
        <CalendarDays className="size-3" />
      </button> : null}
    </div>
  );
}

export function EditDatesDialog({
  item,
  open,
  disabled = false,
  start,
  end,
  onOpenChange,
  onSave,
}: {
  item: RoadmapCardData | null;
  open: boolean;
  disabled?: boolean;
  start: CalendarDate;
  end: CalendarDate;
  onOpenChange: (open: boolean) => void;
  onSave: (horizon: Horizon, start: CalendarDate, end: CalendarDate) => Promise<void>;
}) {
  if (!item) return null;
  return <EditDatesForm key={`${item.id}:${start}:${end}`} item={item} open={open} disabled={disabled} start={start} end={end} onOpenChange={onOpenChange} onSave={onSave} />;
}

function EditDatesForm({ item, open, disabled, start, end, onOpenChange, onSave }: {
  item: RoadmapCardData;
  open: boolean;
  disabled: boolean;
  start: CalendarDate;
  end: CalendarDate;
  onOpenChange: (open: boolean) => void;
  onSave: (horizon: Horizon, start: CalendarDate, end: CalendarDate) => Promise<void>;
}) {
  const [draftHorizon, setDraftHorizon] = useState<Horizon>(item.horizon);
  const [draftStart, setDraftStart] = useState(start);
  const [draftEnd, setDraftEnd] = useState(end);
  const [saving, setSaving] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit schedule</DialogTitle>
          <DialogDescription>{item.title}. Choose a planning horizon and inclusive dates.</DialogDescription>
        </DialogHeader>
        {disabled ? <p role="status" className="rounded-md bg-status-warning-surface p-2 text-sm text-status-warning">Reconciliation required. Reload this page before another edit.</p> : null}
        <label className="grid gap-1 text-xs font-medium">
          Horizon
          <select disabled={disabled} className="h-11 rounded-lg border bg-card px-2 text-sm text-foreground" value={draftHorizon} onChange={(event) => setDraftHorizon(event.target.value as Horizon)}>
            {EDITABLE_HORIZONS.filter((horizon) => isInternalTimelineDestination(item.horizon, horizon)).map((horizon) => <option key={horizon} value={horizon}>{HORIZON_META[horizon].label}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-medium">
          Start
          <input disabled={disabled} className="h-9 rounded-lg border bg-card px-2 text-sm text-foreground" type="date" value={draftStart} onChange={(event) => setDraftStart(event.target.value)} />
        </label>
        <label className="grid gap-1 text-xs font-medium">
          End
          <input disabled={disabled} className="h-9 rounded-lg border bg-card px-2 text-sm text-foreground" type="date" min={draftStart} value={draftEnd} onChange={(event) => setDraftEnd(event.target.value)} />
        </label>
        <DialogFooter showCloseButton>
          <Button
            type="button"
            disabled={disabled || saving || !draftStart || !draftEnd || draftEnd < draftStart}
            onClick={async () => {
              setSaving(true);
              try {
                await onSave(draftHorizon, draftStart, draftEnd);
                onOpenChange(false);
              } catch {
                // The controller has already rolled back and announced the failure.
                // Keep the dialog open so the user can retry without an unhandled rejection.
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "Saving…" : "Save schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function useTimelinePanelNavigation() {
  const { openPanel } = usePanelContext();
  const detail = useSearchParams().get("detail");
  const priorDetail = useRef(detail);
  const trigger = useRef<HTMLElement | null>(null);
  const [triggerItemId, setTriggerItemId] = useState<string | null>(null);

  useEffect(() => {
    if (priorDetail.current && !detail) {
      trigger.current?.focus();
      trigger.current = null;
      setTriggerItemId(null);
    }
    priorDetail.current = detail;
  }, [detail]);

  const openItem = (itemId: string) => {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTriggerItemId(itemId);
    openPanel("roadmapItem", itemId);
  };
  return { openItem, triggerItemId };
}
const ACCESSIBLE_HORIZON_COLORS: Record<RoadmapCardData["horizon"], string> = {
  NOW: "#047857",
  NEXT: "#1d4ed8",
  LATER: "#475569",
  LAUNCHING: "#92400e",
  LAUNCHED: "#0f766e",
  SHIPPED: "#7e22ce",
};
