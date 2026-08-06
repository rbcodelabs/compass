import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({ title, description, eyebrow, actions, className }: { title: ReactNode; description?: ReactNode; eyebrow?: ReactNode; actions?: ReactNode; className?: string }) {
  return <header className={cn("flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between", className)}><div className="min-w-0 max-w-3xl">{eyebrow && <div className="mb-1 text-xs font-medium text-text-subtle">{eyebrow}</div>}<h1 className="text-2xl font-semibold tracking-tight text-text-primary">{title}</h1>{description && <div className="mt-1 text-sm leading-6 text-text-secondary">{description}</div>}</div>{actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}</header>;
}
