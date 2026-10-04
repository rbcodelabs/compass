"use client";

import { useCallback, useState, type ReactNode, type Ref } from "react";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";
import {
  RAIL_WIDE_MEDIA_QUERY,
  railCookieString,
  resolveRailOpen,
  type RailPreference,
} from "@/lib/roadmap/rail-state";

/**
 * Open/closed state for the rail.
 *
 * `open` is the logical state (aria-expanded, inert, the toggle icon). What is
 * painted is decided by `mode`, which is plain CSS, so the first paint is right
 * with no JS: an explicit choice (from the server-read cookie) wins, otherwise
 * the rail is open beside the chart and closed when it would stack above it.
 * The viewport query only feeds `open`; it assumes "wide" on the server, which
 * is the common case and is corrected right after hydration.
 */
export function useRailState({ initialPreference, empty }: { initialPreference: RailPreference | null; empty: boolean }) {
  const [preference, setPreference] = useState<RailPreference | null>(initialPreference);
  const wide = useMediaQuery(RAIL_WIDE_MEDIA_QUERY, true);
  const open = resolveRailOpen({ preference, wide, empty });
  const mode: RailMode = preference ?? (empty ? "open" : "auto");
  const setOpen = useCallback((next: boolean) => {
    const value: RailPreference = next ? "open" : "closed";
    setPreference(value);
    document.cookie = railCookieString(value);
  }, []);
  return { open, mode, setOpen };
}

export type RailMode = "open" | "closed" | "auto";

// The track sizes animate (0 <-> full); the rail itself never reflows mid-transition
// because it keeps its natural width inside a clipped child. The 0.75rem is the gap
// to the timeline, carried as padding inside the clip so nothing is left when closed.
const REGION_CLASS: Record<RailMode, string> = {
  open: "grid-rows-[1fr] min-[1320px]:grid-cols-[calc(20rem+0.75rem)]",
  closed: "grid-rows-[0fr] min-[1320px]:grid-rows-[1fr] min-[1320px]:grid-cols-[0px]",
  auto: "grid-rows-[0fr] min-[1320px]:grid-rows-[1fr] min-[1320px]:grid-cols-[calc(20rem+0.75rem)]",
};
// `visibility` flips after the close animation so a closed rail leaves the tab order and the a11y tree.
const CLIP_CLASS: Record<RailMode, string> = {
  open: "visible",
  closed: "invisible delay-200 motion-reduce:delay-0",
  auto: "max-[1319px]:invisible",
};

export function RailRegion({ id, mode, open, regionRef, children }: {
  id: string;
  mode: RailMode;
  open: boolean;
  regionRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      ref={regionRef}
      data-testid="schedule-rail-region"
      data-state={open ? "open" : "closed"}
      className={cn(
        "grid grid-cols-[minmax(0,1fr)] transition-[grid-template-columns,grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
        "min-[1320px]:sticky min-[1320px]:top-0 min-[1320px]:self-start",
        REGION_CLASS[mode],
      )}
    >
      <div
        // `inert` also covers the window between the logical state flipping and the CSS settling.
        inert={!open}
        className={cn("min-h-0 min-w-0 overflow-hidden transition-[visibility]", CLIP_CLASS[mode])}
      >
        <div className="pb-3 min-[1320px]:w-[calc(20rem+0.75rem)] min-[1320px]:pb-0 min-[1320px]:pr-3">{children}</div>
      </div>
    </div>
  );
}
