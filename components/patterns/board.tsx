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
};

export function BoardColumn({ title, count, description, accent, actions, children, emptyState, footer, className, bodyClassName, bodyRef, bodyId, ...props }: BoardColumnProps) {
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
      <header className="mb-3 shrink-0 md:sticky md:top-0 md:z-10 md:-mx-3 md:-mt-3 md:bg-surface-inset md:px-3 md:pt-3 md:pb-3">
        <div className="flex items-center gap-2">
          {accent && <span aria-hidden className={cn("h-4 w-1 rounded-full", accents[accent])} />}
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{title}</h3>
          {typeof count === "number" && <span aria-label={`${count} items`} className="rounded-full bg-surface-panel px-1.5 py-0.5 text-xs text-text-subtle">{count}</span>}
          {actions}
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
