import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageSection({ title, description, actions, children, className }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={cn("space-y-4", className)}>{(title || description || actions) && <div className="flex items-start justify-between gap-4"><div>{title && <h2 className="text-base font-semibold text-text-primary">{title}</h2>}{description && <div className="mt-1 text-sm leading-6 text-text-subtle">{description}</div>}</div>{actions && <div className="shrink-0">{actions}</div>}</div>}{children}</section>;
}
