import type { ComponentProps, ReactNode, Ref } from "react";
import { cn } from "@/lib/utils";
import { BoardColumnLayoutActions, type BoardColumnLayoutControls } from "./board-pinned";

/*
 * Pinned columns (opt-in; boards that don't pass `layoutControls` render exactly as before).
 *
 * Docking is a property of ANY column, not of one board. A board that wants it:
 *   1. keeps a layout with lib/board-layout.ts (`resolveBoardLayout` for the starting layout, then the pure
 *      `pinColumn` / `unpinColumn` / `moveColumn` / `setColumnCollapsed` transitions) and persists it however
 *      it likes (the roadmap board stores it in the saved view, see components/roadmap/column-layout-context.tsx);
 *   2. renders the unpinned columns, in `columnOrder`, inside `<Board>` (the horizontal scroller);
 *   3. renders the pinned columns in a `<BoardPinnedRegion>` that is a SIBLING of `<Board>` (outside the
 *      scroller), each as a `<BoardColumn className={PINNED_COLUMN_CLASS} bodyClassName={PINNED_COLUMN_BODY_CLASS}>`
 *      or, when collapsed, a `<CollapsedColumnTab>`;
 *   4. passes each `BoardColumn` a `layoutControls` object (pin toggle, collapse, move left/right).
 * Below md a board should ignore pinning and render every column in the scroller.
 * Components live in ./board-pinned.tsx; all are re-exported from this module.
 */
export * from "./board-pinned";

/**
 * The width of the scroller's tapered right edge, in two literal class strings (Tailwind needs literals) that MUST stay in
 * step: the mask fades the last 2rem of the scrollport, and the board's inner track takes `md:pr-8` (2rem) of right padding
 * while docked columns exist, so at full scroll-end the last column sits wholly outside the fade.
 */
export const BOARD_FADE_END_CLASS = "md:[mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)]";
export const BOARD_FADE_END_TRACK_CLASS = "md:pr-8";

/**
 * `fadeEnd`: tapers the last 2rem of the scrollport (md and up) so columns fade out instead of being hard-cut where a
 * `BoardPinnedRegion` sits beside the scroller. Add `BOARD_FADE_END_TRACK_CLASS` to the board's inner track alongside it.
 * Use it only while pinned columns are rendered.
 */
export function Board({ children, label = "Board", className, fadeEnd = false }: { children: ReactNode; label?: string; className?: string; fadeEnd?: boolean }) {
  // Mobile columns size against this scrollport, including nested swimlanes,
  // rather than the viewport (which may also contain panels or lane gutters).
  return <div role="region" aria-label={label} className={cn("@container flex min-w-0 snap-x gap-4 overflow-x-auto pb-3", fadeEnd && BOARD_FADE_END_CLASS, className)}>{children}</div>;
}

type BoardColumnProps = Omit<ComponentProps<"section">, "title"> & {
  title: ReactNode;
  count?: number;
  // Purely visual/advisory WIP limit — see docs/decisions/0005/0006
  // (Superseded). When set, the count badge reads "count/limit" and swaps to
  // a warning tone once count exceeds limit. Never affects behavior.
  limit?: number | null;
  description?: ReactNode;
  accent?: "neutral" | "info" | "success" | "warning" | "danger";
  actions?: ReactNode;
  emptyState?: ReactNode;
  footer?: ReactNode;
  bodyClassName?: string;
  bodyRef?: Ref<HTMLDivElement>;
  bodyId?: string;
  /** Opt in to pin / collapse / reorder controls in the header. See the usage note above. */
  layoutControls?: BoardColumnLayoutControls;
};

export function BoardColumn({ title, count, limit, description, accent, actions, children, emptyState, footer, className, bodyClassName, bodyRef, bodyId, layoutControls, ...props }: BoardColumnProps) {
  const accents = { neutral: "bg-status-neutral", info: "bg-status-info", success: "bg-status-success", warning: "bg-status-warning", danger: "bg-status-danger" };
  const overLimit = typeof count === "number" && typeof limit === "number" && count > limit;
  const badgeLabel = typeof limit === "number" ? `${count}/${limit}` : String(count);
  return (
    <section className={cn("group/board-column flex w-72 shrink-0 snap-start flex-col rounded-xl border border-border-default bg-surface-inset p-3", className)} {...props}>
      {/*
        md+: the header pins to the top of THIS column's own scroll region (the body div
        below), so it stays visible while just that column's cards scroll — no coordination
        needed with the page header's height since each column scrolls independently, not
        the shared page scroll. Below md, left as normal flow: mobile keeps today's
        whole-page-scrolls behavior unchanged.
      */}
      <header className="mb-3 shrink-0 md:sticky md:top-0 md:z-10 md:-mx-3 md:-mt-3 md:bg-surface-inset md:px-3 md:pt-3 md:pb-3">
        <div className="flex items-center gap-2">
          {accent && <span aria-hidden className={cn("h-4 w-1 rounded-full", accents[accent])} />}
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{title}</h3>
          {typeof count === "number" && (
            <span
              aria-label={typeof limit === "number" ? `${count} of ${limit} items` : `${count} items`}
              className={cn(
                "rounded-full px-1.5 py-0.5 text-xs",
                overLimit ? "bg-status-warning-surface text-status-warning" : "bg-surface-panel text-text-subtle"
              )}
            >
              {badgeLabel}
            </span>
          )}
          {actions}
          {layoutControls ? <BoardColumnLayoutActions controls={layoutControls} /> : null}
        </div>
        {description && <div className="mt-1 text-xs text-text-subtle">{description}</div>}
      </header>
      {/*
        overscroll-Y-contain, not overscroll-contain: the intent is only to stop VERTICAL
        scroll chaining (so hitting the end of a column doesn't scroll the page). The
        unaxed version also contains the horizontal axis, which broke trackpad
        side-scrolling whenever the cursor sat over a column — the wheel event was
        swallowed here instead of chaining up to the Board's overflow-x-auto.

        -mx-3/px-3 (matching the header above) pulls this scroll box out to the column's
        edges and pads the content back in, so a card's shadow and focus/drag ring have
        room to render instead of being sliced off at the scroll boundary. Note
        overflow-y:auto computes overflow-x to auto as well, so this box clips
        horizontally whether or not we ask it to.
      */}
      <div id={bodyId} ref={bodyRef} className={cn("space-y-3 md:-mx-3 md:max-h-[65vh] md:overflow-y-auto md:overscroll-y-contain md:px-3", bodyClassName)}>{children || emptyState}</div>
      {footer && <div className="mt-3 shrink-0">{footer}</div>}
    </section>
  );
}
