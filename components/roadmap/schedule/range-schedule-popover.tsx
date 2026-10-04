"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { solutionStatusBadge } from "@/lib/solution-status";
import type { CalendarDate } from "@/lib/roadmap/scheduling";
import type { SolutionRailItem } from "./schedule-rail";

const WIDTH = 320;
const MAX_ROWS = 6;

function formatDay(date: CalendarDate): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}

/**
 * "Schedule from…" popover shown after click-dragging a range on an empty
 * timeline row. Lists unscheduled solutions, same-squad first and then by score
 * (the caller sorts); choosing one creates its roadmap item over that range.
 */
export function RangeSchedulePopover({ anchor, range, candidates, squadLabel, onPick, onClose }: {
  anchor: { x: number; y: number };
  range: { start: CalendarDate; end: CalendarDate };
  candidates: SolutionRailItem[];
  squadLabel: string;
  onPick: (item: SolutionRailItem) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;
  const left = Math.max(8, Math.min(anchor.x, window.innerWidth - WIDTH - 8));
  const top = Math.max(8, Math.min(anchor.y + 10, window.innerHeight - 320));
  const list = candidates.slice(0, MAX_ROWS);
  return createPortal(
    // Body-level fixed layer; an inline z-index keeps it out of the Tailwind overlay ladder.
    <div
      ref={ref}
      role="dialog"
      aria-label="Schedule from…"
      data-testid="range-schedule-popover"
      className="fixed flex flex-col gap-1 rounded-lg border bg-popover p-2 text-sm text-popover-foreground shadow-lg"
      style={{ left, top, width: WIDTH, zIndex: 85 }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const buttons = [...(ref.current?.querySelectorAll<HTMLElement>("button[data-pick]") ?? [])];
        const at = buttons.indexOf(document.activeElement as HTMLElement);
        const next = (at + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}
    >
      <h4 className="px-1 pb-1 text-xs font-semibold text-muted-foreground">
        Schedule from… · {formatDay(range.start)} – {formatDay(range.end)} · {squadLabel}
      </h4>
      {list.length === 0 ? <p className="px-1 py-2 text-muted-foreground">Nothing left to schedule.</p> : null}
      {list.map((item) => (
        <button
          key={item.id}
          type="button"
          data-pick={item.id}
          onClick={() => onPick(item)}
          className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none")}
        >
          <span className="min-w-0 flex-1 truncate font-medium">{item.title}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {solutionStatusBadge(item.status ?? "VALIDATED").label}{typeof item.score === "number" ? ` · ${Math.round(item.score)}` : ""}
          </span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
