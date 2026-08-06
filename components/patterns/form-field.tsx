import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export function FormField({ id, label, description, error, required, children, className }: { id: string; label: ReactNode; description?: ReactNode; error?: ReactNode; required?: boolean; children: ReactNode; className?: string }) {
  const helpId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return <div className={cn("space-y-1.5", className)}><Label htmlFor={id}>{label}{required && <span aria-hidden className="text-status-danger">*</span>}</Label>{description && <div id={helpId} className="text-xs leading-5 text-text-subtle">{description}</div>}<div aria-describedby={[helpId, errorId].filter(Boolean).join(" ") || undefined}>{children}</div>{error && <div id={errorId} role="alert" className="text-xs text-status-danger">{error}</div>}</div>;
}
