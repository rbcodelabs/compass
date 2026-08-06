import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function EmptyState({ icon, title, description, primaryAction, secondaryAction, compact = false, className }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; primaryAction?: ReactNode; secondaryAction?: ReactNode; compact?: boolean; className?: string }) {
  return <div className={cn("flex flex-col items-center justify-center rounded-xl border border-dashed border-border-strong bg-surface-inset px-6 text-center", compact ? "min-h-32 py-6" : "min-h-56 py-10", className)}>{icon && <div className="mb-3 rounded-full bg-surface-panel p-2.5 text-text-subtle shadow-[var(--shadow-card)]">{icon}</div>}<h3 className="text-sm font-semibold text-text-primary">{title}</h3>{description && <div className="mt-1 max-w-md text-sm leading-6 text-text-subtle">{description}</div>}{(primaryAction || secondaryAction) && <div className="mt-4 flex flex-wrap justify-center gap-2">{primaryAction}{secondaryAction}</div>}</div>;
}
