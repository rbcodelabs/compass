import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({ title, description, eyebrow, actions, className, sticky }: { title: ReactNode; description?: ReactNode; eyebrow?: ReactNode; actions?: ReactNode; className?: string; sticky?: boolean }) {
  return (
    <header
      className={cn(
        "flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between",
        // Opt-in: pins the page header to the top of its scroll container (SidebarInset)
        // so it stays visible while long page content — e.g. a tall Kanban column — scrolls
        // beneath it. Opt-in rather than default so non-board pages are unaffected.
        sticky && "sticky top-0 z-20 -mx-4 -mt-4 border-b border-border-default bg-surface-app px-4 py-4 sm:-mx-6 sm:-mt-6 sm:px-6 sm:py-6 md:-mx-8 md:-mt-8 md:px-8 md:py-8",
        className
      )}
    >
      <div className="min-w-0 max-w-3xl">
        {eyebrow && <div className="mb-1 text-xs font-medium text-text-subtle">{eyebrow}</div>}
        <h1 className="text-2xl font-semibold tracking-tight text-text-primary">{title}</h1>
        {description && <div className="mt-1 text-sm leading-6 text-text-secondary">{description}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
