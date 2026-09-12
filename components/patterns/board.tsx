import type { ComponentProps, ReactNode, Ref } from "react";
import { cn } from "@/lib/utils";

export function Board({ children, label = "Board", className }: { children: ReactNode; label?: string; className?: string }) {
  return <div role="region" aria-label={label} className={cn("flex min-w-0 snap-x gap-4 overflow-x-auto pb-3", className)}>{children}</div>;
}

type BoardColumnProps = Omit<ComponentProps<"section">, "title"> & {
  title: ReactNode;
  count?: number;
  description?: ReactNode;
  accent?: "neutral" | "info" | "success" | "warning" | "danger";
  actions?: ReactNode;
  emptyState?: ReactNode;
  footer?: ReactNode;
  bodyClassName?: string;
  bodyRef?: Ref<HTMLDivElement>;
  bodyId?: string;
  /**
   * Set when this column is nested inside another grouping container (e.g. a
   * swimlane lane) instead of sitting directly on a board.
   *
   * A top-level column owns its own vertical scroll region, which is what the
   * default styling assumes: the header is `sticky top-0` and bleeds its
   * background out to the column's edges with negative margins so cards
   * scroll *under* it cleanly.
   *
   * Both assumptions break when nested. `sticky` resolves against the nearest
   * scrolling ancestor — which is then the lane/board, not this column — so
   * the header detaches from its own column and rides up over the lane header
   * above it (`z-10` puts it on top). The negative-margin bleed paints 12px
   * outside the column's padding box, escaping the lane's rounded border. And
   * `max-h-[65vh]` caps a column that should just be as tall as its lane.
   *
   * Nested columns therefore use a plain static header and no scroll region,
   * letting the lane own scrolling.
   */
  nested?: boolean;
};

export function BoardColumn({ title, count, description, accent, actions, children, emptyState, footer, className, bodyClassName, bodyRef, bodyId, nested = false, ...props }: BoardColumnProps) {
  const accents = { neutral: "bg-status-neutral", info: "bg-status-info", success: "bg-status-success", warning: "bg-status-warning", danger: "bg-status-danger" };
  return (
    <section className={cn("flex w-72 shrink-0 snap-start flex-col rounded-xl border border-border-default bg-surface-inset p-3", className)} {...props}>
      {/*
        md+: the header pins to the top of THIS column's own scroll region (the body div
        below), so it stays visible while just that column's cards scroll — no coordination
        needed with the page header's height since each column scrolls independently, not
        the shared page scroll. Below md, left as normal flow: mobile keeps today's
        whole-page-scrolls behavior unchanged.
      */}
      <header
        className={cn(
          "mb-3 shrink-0",
          !nested && "md:sticky md:top-0 md:z-10 md:-mx-3 md:-mt-3 md:bg-surface-inset md:px-3 md:pt-3 md:pb-3"
        )}
      >
        <div className="flex items-center gap-2">
          {accent && <span aria-hidden className={cn("h-4 w-1 rounded-full", accents[accent])} />}
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{title}</h3>
          {typeof count === "number" && <span aria-label={`${count} items`} className="rounded-full bg-surface-panel px-1.5 py-0.5 text-xs text-text-subtle">{count}</span>}
          {actions}
        </div>
        {description && <div className="mt-1 text-xs text-text-subtle">{description}</div>}
      </header>
      <div
        id={bodyId}
        ref={bodyRef}
        className={cn(
          "space-y-3",
          !nested && "md:max-h-[65vh] md:overflow-y-auto md:overscroll-contain",
          bodyClassName
        )}
      >{children || emptyState}</div>
      {footer && <div className="mt-3 shrink-0">{footer}</div>}
    </section>
  );
}
