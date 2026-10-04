"use client";

import { useEffect, useSyncExternalStore } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { dismissUndoToast, getUndoToasts, subscribeUndoToasts, type UndoToast } from "@/lib/ui/undo-toast";

const DEFAULT_DURATION_MS = 8000;
const NO_TOASTS: readonly UndoToast[] = [];

/**
 * Renders the toasts pushed with pushUndoToast(). One polite live region, so a
 * screen reader hears each message and its Undo action; each toast dismisses
 * itself after a few seconds, and Undo is always keyboard reachable.
 */
export function UndoToastHost() {
  const toasts = useSyncExternalStore(subscribeUndoToasts, getUndoToasts, () => NO_TOASTS);
  return (
    // An inline z-index: this is a body-level fixed layer above panels and dialogs, outside the Tailwind overlay ladder.
    <div
      data-testid="undo-toast-host"
      role="region"
      aria-label="Notifications"
      className="pointer-events-none fixed inset-x-0 bottom-20 flex flex-col items-center gap-2 px-3 md:bottom-4"
      style={{ zIndex: 90 }}
    >
      <div role="status" aria-live="polite" className="flex flex-col items-center gap-2">
        {toasts.map((toast) => <ToastItem key={toast.id} toast={toast} />)}
      </div>
    </div>
  );
}

function ToastItem({ toast }: { toast: UndoToast }) {
  useEffect(() => {
    const timer = window.setTimeout(() => dismissUndoToast(toast.id), toast.durationMs ?? DEFAULT_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.durationMs]);
  return (
    <div
      data-testid="undo-toast"
      data-tone={toast.tone ?? "default"}
      className={cn(
        "pointer-events-auto flex max-w-[min(32rem,calc(100vw-1.5rem))] items-center gap-3 rounded-lg border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg",
        toast.tone === "auto" && "border-primary/40",
      )}
    >
      <span className="min-w-0 flex-1">{toast.message}</span>
      {toast.onAction ? (
        <button
          type="button"
          className="shrink-0 rounded px-2 py-1 text-sm font-semibold text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={async () => {
            dismissUndoToast(toast.id);
            await toast.onAction?.();
          }}
        >
          {toast.actionLabel ?? "Undo"}
        </button>
      ) : null}
      <button
        type="button"
        aria-label="Dismiss notification"
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => dismissUndoToast(toast.id)}
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
