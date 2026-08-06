import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

type EntityCardProps = Omit<ComponentProps<"article">, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  leading?: ReactNode;
  metadata?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  interactive?: boolean;
  selected?: boolean;
};

export function EntityCard({ title, description, eyebrow, leading, metadata, status, actions, footer, interactive = false, selected = false, children, className, ...props }: EntityCardProps) {
  return (
    <article
      data-slot="card"
      data-pattern="entity-card"
      data-selected={selected || undefined}
      className={cn(
        "group rounded-xl border bg-surface-card p-4 shadow-[var(--shadow-card)] transition",
        selected ? "border-border-interactive ring-2 ring-ring/15" : "border-border-default",
        interactive && "hover:border-border-strong hover:shadow-[var(--shadow-panel)] focus-within:border-border-focus",
        className
      )}
      {...props}
    >
      <div className="flex items-start gap-2">
        {leading && <div className="shrink-0">{leading}</div>}
        <div className="min-w-0 flex-1">
          {eyebrow && <div className="mb-1 text-xs font-medium text-text-subtle">{eyebrow}</div>}
          <h3 className="text-sm font-semibold leading-5 text-text-primary">{title}</h3>
          {description && <div className="mt-1 line-clamp-2 text-sm leading-5 text-text-secondary">{description}</div>}
        </div>
        {status && <div className="shrink-0">{status}</div>}
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
      {children && <div className="mt-3">{children}</div>}
      {(metadata || footer) && <div className="mt-4 flex items-center justify-between gap-3 border-t border-border-default pt-3 text-xs text-text-subtle"><div>{metadata}</div><div>{footer}</div></div>}
    </article>
  );
}
