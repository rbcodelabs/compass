import { cn } from "@/lib/utils";

export function LoadingState({ rows = 3, label = "Loading", className }: { rows?: number; label?: string; className?: string }) {
  return <div role="status" aria-label={label} className={cn("space-y-3", className)}>{Array.from({ length: rows }, (_, index) => <div key={index} className="animate-pulse rounded-xl border border-border-default bg-surface-panel p-4"><div className="h-3 w-2/5 rounded bg-surface-inset" /><div className="mt-3 h-2.5 w-4/5 rounded bg-surface-inset" /></div>)}<span className="sr-only">{label}</span></div>;
}
