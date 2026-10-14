/**
 * A tiny module-level store for transient toasts with an optional action
 * (Undo). Any client code can push one without threading a provider through;
 * <UndoToastHost /> (mounted once in the workspace layout) renders them.
 */
export type UndoToast = {
  id: string;
  message: string;
  /** Label of the single action button, usually "Undo". */
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
  tone?: "default" | "auto";
  /** Milliseconds before the toast dismisses itself. Defaults to 8000. */
  durationMs?: number;
};

export type UndoToastInput = Omit<UndoToast, "id">;

type Listener = () => void;

const listeners = new Set<Listener>();
let toasts: readonly UndoToast[] = [];
let counter = 0;
const MAX_VISIBLE = 4;

function emit() {
  for (const listener of listeners) listener();
}

export function pushUndoToast(input: UndoToastInput): string {
  const id = `undo-toast-${++counter}`;
  toasts = [...toasts, { ...input, id }].slice(-MAX_VISIBLE);
  emit();
  return id;
}

export function dismissUndoToast(id: string): void {
  const next = toasts.filter((toast) => toast.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

export function subscribeUndoToasts(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getUndoToasts(): readonly UndoToast[] {
  return toasts;
}

/** Test helper: drop every toast and listener bookkeeping. */
export function resetUndoToasts(): void {
  toasts = [];
  emit();
}
