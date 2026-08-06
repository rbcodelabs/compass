import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Toolbar({ leading, filters, views, actions, className, label = "Page tools" }: { leading?: ReactNode; filters?: ReactNode; views?: ReactNode; actions?: ReactNode; className?: string; label?: string }) {
  return <div role="toolbar" aria-label={label} className={cn("flex flex-wrap items-center gap-2 rounded-xl border border-border-default bg-surface-panel p-2 shadow-[var(--shadow-card)]", className)}>{leading && <div className="min-w-48 flex-1">{leading}</div>}{filters && <div className="flex flex-wrap items-center gap-2">{filters}</div>}{views && <div className="ml-auto flex items-center gap-1">{views}</div>}{actions && <div className={cn("flex items-center gap-2", !views && "ml-auto")}>{actions}</div>}</div>;
}

export function FilterBar({ children, onClear, clearLabel = "Clear filters", className }: { children: ReactNode; onClear?: () => void; clearLabel?: string; className?: string }) {
  return <div className={cn("flex flex-wrap items-center gap-2", className)}>{children}{onClear && <button type="button" onClick={onClear} className="rounded-md px-2 py-1 text-xs font-medium text-text-subtle hover:bg-surface-interactive hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus">{clearLabel}</button>}</div>;
}
