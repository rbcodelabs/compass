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
    <section className={cn("w-72 shrink-0 snap-start rounded-xl border border-border-default bg-surface-inset p-3", className)} {...props}>
      <header className="mb-3">
        <div className="flex items-center gap-2">
          {accent && <span aria-hidden className={cn("h-4 w-1 rounded-full", accents[accent])} />}
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{title}</h3>
          {typeof count === "number" && <span aria-label={`${count} items`} className="rounded-full bg-surface-panel px-1.5 py-0.5 text-xs text-text-subtle">{count}</span>}
          {actions}
        </div>
        {description && <div className="mt-1 text-xs text-text-subtle">{description}</div>}
      </header>
      <div id={bodyId} ref={bodyRef} className={cn("space-y-3", bodyClassName)}>{children || emptyState}</div>
      {footer && <div className="mt-3">{footer}</div>}
    </section>
  );
}
