import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SettingsSection({ title, description, children, actions, danger = false, className }: { title: ReactNode; description?: ReactNode; children: ReactNode; actions?: ReactNode; danger?: boolean; className?: string }) {
  return <section className={cn("overflow-hidden rounded-xl border bg-surface-panel shadow-[var(--shadow-card)]", danger ? "border-status-danger/30" : "border-border-default", className)}><header className={cn("flex items-start justify-between gap-4 border-b px-5 py-4", danger ? "border-status-danger/20 bg-status-danger-surface" : "border-border-default")}><div><h2 className={cn("text-base font-semibold", danger ? "text-status-danger" : "text-text-primary")}>{title}</h2>{description && <div className="mt-1 max-w-2xl text-sm leading-6 text-text-subtle">{description}</div>}</div>{actions && <div className="shrink-0">{actions}</div>}</header><div className="p-5">{children}</div></section>;
}
