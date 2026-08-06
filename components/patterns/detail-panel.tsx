import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function DetailPanel({ title, description, eyebrow, actions, children, footer, className }: { title: ReactNode; description?: ReactNode; eyebrow?: ReactNode; actions?: ReactNode; children: ReactNode; footer?: ReactNode; className?: string }) {
  return <aside className={cn("flex h-full min-h-0 flex-col bg-surface-panel", className)}><header className="border-b border-border-default p-4"><div className="flex items-start justify-between gap-4"><div>{eyebrow && <div className="mb-1 text-xs font-medium text-text-subtle">{eyebrow}</div>}<h2 className="text-base font-semibold text-text-primary">{title}</h2>{description && <div className="mt-1 text-sm text-text-subtle">{description}</div>}</div>{actions}</div></header><div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>{footer && <footer className="border-t border-border-default bg-surface-inset p-4">{footer}</footer>}</aside>;
}

export function DetailPanelSection({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={cn("space-y-3 border-b border-border-default py-4 first:pt-0 last:border-b-0 last:pb-0", className)}>{(title || actions) && <div className="flex items-center justify-between gap-3">{title && <h3 className="text-sm font-semibold text-text-primary">{title}</h3>}{actions}</div>}{children}</section>;
}
