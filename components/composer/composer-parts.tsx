"use client";

/**
 * The building blocks every docked "New …" composer panel shares (feedback,
 * opportunity): the draft-restore gate, the large borderless title, the
 * Markdown body with its one-click outline, and the sticky footer with its
 * ⌘/Ctrl+Enter hint and confirmed discard. Each composer supplies only its own
 * fields; the behaviour users learn in one works identically in the other.
 */

import { useEffect, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { AlertCircle, FileText } from "lucide-react";

import { MarkdownDescriptionEditor } from "@/components/markdown-description-editor";
import { ConfirmDialog } from "@/components/patterns/confirm-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** "⌘" on Apple platforms, "Ctrl" elsewhere. SSR renders "Ctrl", refined after mount. */
export function useSubmitShortcutLabel() {
  const [label, setLabel] = useState("Ctrl");
  useEffect(() => {
    if (/Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)) setLabel("⌘");
  }, []);
  return label;
}

export function isSubmitShortcut(event: KeyboardEvent) {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey);
}

/**
 * Reads a draft only after mount. A pinned user can deep-link straight to a
 * composer, so it can render on the server — where there is no storage, and
 * reading it would produce a hydration mismatch. `null` until then.
 */
export function useRestoredDraft<T>(draftKey: string, load: (key: string) => T | null) {
  const [initial, setInitial] = useState<{ key: string; draft: T | null } | null>(null);
  useEffect(() => {
    setInitial({ key: draftKey, draft: load(draftKey) });
  }, [draftKey, load]);
  return initial && initial.key === draftKey ? initial : null;
}

/**
 * After the panel's own open animation/focus handling, put the caret at the
 * end of the title — the first thing everyone types.
 */
export function useFocusOnOpen(ref: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const input = ref.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, [ref]);
}

/** Appends an outline below whatever is already written, or starts with it. */
export function appendTemplate(current: string, template: string) {
  return current.trim() ? `${current.trimEnd()}\n\n${template}` : template;
}

export function ComposerRestoredNotice() {
  return (
    <p role="status" className="-mb-2 text-xs text-text-subtle">
      Restored your unsent draft.
    </p>
  );
}

/** Characters from the limit at which the title counter appears. */
const TITLE_COUNTER_THRESHOLD = 55;

export function ComposerTitleField({
  inputRef,
  id,
  value,
  onChange,
  maxLength,
  placeholder,
  invalid,
  errorId,
  disabled,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  id: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  placeholder: string;
  invalid: boolean;
  errorId: string;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="sr-only">
        Title
      </label>
      <input
        ref={inputRef}
        id={id}
        name="title"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        maxLength={maxLength}
        placeholder={placeholder}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
        disabled={disabled}
        autoComplete="off"
        className={cn(
          "w-full border-0 bg-transparent p-0 text-xl font-semibold leading-tight text-text-primary",
          "placeholder:text-text-disabled focus:outline-none focus-visible:outline-none",
          "disabled:opacity-60",
        )}
      />
      <div
        aria-hidden
        className={cn("h-px w-full transition-colors", invalid ? "bg-status-danger" : "bg-border-default")}
      />
      {value.length > maxLength - TITLE_COUNTER_THRESHOLD && (
        <p className="text-right text-[11px] text-text-subtle" aria-live="polite">
          {value.length}/{maxLength}
        </p>
      )}
    </div>
  );
}

/** The Markdown body: a label row with the outline button, then the editor filling the height. */
export function ComposerMarkdownField({
  labelId,
  label,
  value,
  onChange,
  placeholder,
  disabled,
  templateLabel,
  onInsertTemplate,
  maxLength,
  onFiles,
}: {
  labelId: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled: boolean;
  templateLabel: string;
  onInsertTemplate: () => void;
  /** When set, a counter appears near the limit and turns red past it. */
  maxLength?: number;
  onFiles?: (files: File[]) => void;
}) {
  const countVisible = maxLength !== undefined && value.length > maxLength * 0.9;
  return (
    <div className="flex min-h-72 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span id={labelId} className="text-xs font-medium text-text-secondary">
          {label} <span className="font-normal text-text-subtle">· Markdown supported</span>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onInsertTemplate}
          disabled={disabled}
          className="text-text-secondary"
        >
          <FileText aria-hidden />
          {templateLabel}
        </Button>
      </div>
      <MarkdownDescriptionEditor
        value={value}
        onChange={onChange}
        label={label}
        placeholder={placeholder}
        disabled={disabled}
        fill
        onFiles={onFiles}
        footerNote={null}
      />
      {countVisible && (
        <p
          className={cn("text-right text-[11px]", value.length > maxLength ? "text-status-danger" : "text-text-subtle")}
          aria-live="polite"
        >
          {value.length.toLocaleString()}/{maxLength.toLocaleString()}
        </p>
      )}
    </div>
  );
}

/**
 * The sticky footer: inline error, a status line (pending, a blocking reason,
 * or the ⌘/Ctrl+Enter hint with "Draft saved"), Cancel and Submit.
 *
 * Cancel on an empty draft just closes. On a non-empty one it asks "Discard
 * this draft?" first — closing the panel instead (X or Esc) keeps the draft.
 */
export function ComposerFooter({
  error,
  errorId,
  isPending,
  statusNote,
  draftEmpty,
  onClose,
  discardDescription,
  onDiscard,
  submitDisabled,
}: {
  error: string | null;
  errorId: string;
  isPending: boolean;
  /** Shown instead of the shortcut hint (e.g. "Waiting for attachments…"). */
  statusNote?: ReactNode;
  draftEmpty: boolean;
  onClose: () => void;
  discardDescription: string;
  onDiscard: () => void;
  submitDisabled: boolean;
}) {
  const shortcut = useSubmitShortcutLabel();
  return (
    <footer className="shrink-0 border-t border-border-default bg-surface-inset px-5 py-3">
      {error && (
        <p id={errorId} role="alert" className="mb-2 flex items-start gap-1.5 text-xs text-status-danger">
          <AlertCircle aria-hidden className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-[11px] text-text-subtle" aria-live="polite">
          {isPending ? (
            "Submitting…"
          ) : statusNote && !error ? (
            statusNote
          ) : (
            <>
              <kbd className="font-sans">{shortcut}</kbd>
              <span aria-hidden>+</span>
              <kbd className="font-sans">Enter</kbd> to submit
              {!draftEmpty && <span className="hidden sm:inline"> · Draft saved</span>}
            </>
          )}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          {draftEmpty ? (
            <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={onClose}>
              Cancel
            </Button>
          ) : (
            <ConfirmDialog
              trigger={
                <Button type="button" variant="ghost" size="sm" disabled={isPending}>
                  Cancel
                </Button>
              }
              title="Discard this draft?"
              description={discardDescription}
              confirmLabel="Discard draft"
              cancelLabel="Keep editing"
              destructive
              onConfirm={onDiscard}
            />
          )}
          <Button type="submit" size="sm" disabled={submitDisabled}>
            {isPending ? "Submitting…" : "Submit"}
          </Button>
        </div>
      </div>
    </footer>
  );
}
