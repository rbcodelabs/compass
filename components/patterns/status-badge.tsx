import type { ComponentProps, ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const statusBadgeVariants = cva("inline-flex h-5 w-fit items-center gap-1 rounded-full px-2 text-xs font-medium [&_svg]:size-3", { variants: { status: { neutral: "bg-status-neutral-surface text-status-neutral", info: "bg-status-info-surface text-status-info", success: "bg-status-success-surface text-status-success", warning: "bg-status-warning-surface text-status-warning", danger: "bg-status-danger-surface text-status-danger" } }, defaultVariants: { status: "neutral" } });

export function StatusBadge({ status, icon, children, className, ...props }: ComponentProps<"span"> & { icon?: ReactNode } & VariantProps<typeof statusBadgeVariants>) {
  return <span className={cn(statusBadgeVariants({ status }), className)} {...props}>{icon}{children}</span>;
}

export function MetricBadge({ label, value, className }: { label: string; value: ReactNode; className?: string }) {
  return <span className={cn("inline-flex h-6 items-center gap-1.5 rounded-lg border border-border-default bg-surface-panel px-2 text-xs", className)}><span className="text-text-subtle">{label}</span><strong className="font-semibold text-text-primary">{value}</strong></span>;
}
