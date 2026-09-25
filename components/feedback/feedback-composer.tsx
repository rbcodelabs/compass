"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ClipboardEvent,
} from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Bug,
  FileText,
  Lightbulb,
  Paperclip,
  RotateCw,
  Upload,
  X,
} from "lucide-react";

import { createFeedback } from "@/app/[orgSlug]/[workspaceSlug]/feedback/actions";
import { MarkdownDescriptionEditor } from "@/components/markdown-description-editor";
import { ConfirmDialog } from "@/components/patterns/confirm-dialog";
import { usePanelContext } from "@/components/panels/panel-context";
import { Button } from "@/components/ui/button";
import { FEEDBACK_DESCRIPTION_MAX_LENGTH, FEEDBACK_TITLE_MAX_LENGTH } from "@/lib/feedback";
import {
  FEEDBACK_ATTACHMENT_ACCEPT,
  FEEDBACK_ATTACHMENT_LIMITS_HINT,
  FEEDBACK_ATTACHMENT_MAX_COUNT,
  formatAttachmentSize,
} from "@/lib/feedback-attachment-rules";
import {
  clearFeedbackDraft,
  feedbackDraftKey,
  isFeedbackDraftEmpty,
  loadFeedbackDraft,
  saveFeedbackDraft,
  type FeedbackDraft,
} from "@/lib/feedback-draft";
import {
  FEEDBACK_TONE_CLASS,
  FEEDBACK_TYPES,
  FEEDBACK_TYPE_META,
  type FeedbackTypeValue,
} from "@/lib/feedback-meta";
import { cn } from "@/lib/utils";
import {
  defaultAttachmentTransport,
  toDraftAttachments,
  useFeedbackAttachmentUploads,
  type AttachmentTransport,
  type ComposerAttachment,
} from "./use-feedback-attachment-uploads";

/** Per-type copy. Tone and label come from lib/feedback-meta. */
export const FEEDBACK_COMPOSER_COPY: Record<
  FeedbackTypeValue,
  { description: string; placeholder: string; templateLabel: string; template: string }
> = {
  IDEA: {
    description: "Suggest an improvement",
    placeholder: "What problem does this solve? Who runs into it, and what would a great outcome look like?",
    templateLabel: "Insert idea outline",
    template: "## Problem\n\n\n\n## Proposed idea\n\n\n\n## Who benefits\n\n",
  },
  BUG: {
    description: "Something isn't working",
    placeholder: "What went wrong? Include steps to reproduce, what you expected, and what actually happened.",
    templateLabel: "Insert bug template",
    template: "## Steps to reproduce\n\n1. \n\n## Expected result\n\n\n\n## Actual result\n\n",
  },
};

const TYPE_ICON = { IDEA: Lightbulb, BUG: Bug } as const;

function useSubmitShortcutLabel() {
  // Rendered on the server too, so start neutral and refine after mount.
  const [label, setLabel] = useState("Ctrl");
  useEffect(() => {
    if (/Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)) setLabel("⌘");
  }, []);
  return label;
}

function hasFiles(event: DragEvent) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

export type FeedbackComposerProps = {
  orgSlug: string;
  workspaceSlug: string;
  /** Test seam; production uses Blob direct upload through the server actions. */
  transport?: AttachmentTransport;
};

/**
 * The "New feedback" composer, rendered by PanelShell in the detail-panel
 * slot (`?detail=feedback-new:new`).
 *
 * The draft is read from localStorage only after mount — a pinned user can
 * deep-link straight to the composer, so it can render on the server, where
 * there is no storage and reading it would produce a hydration mismatch.
 */
export function FeedbackComposer({ orgSlug, workspaceSlug, transport }: FeedbackComposerProps) {
  const draftKey = feedbackDraftKey(orgSlug, workspaceSlug);
  const [initial, setInitial] = useState<{ draft: FeedbackDraft | null } | null>(null);
  useEffect(() => {
    setInitial({ draft: loadFeedbackDraft(draftKey) });
  }, [draftKey]);

  if (!initial) return <div className="flex-1" aria-busy="true" />;
  return (
    <ComposerForm
      key={draftKey}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      draftKey={draftKey}
      restored={initial.draft}
      transport={transport}
    />
  );
}

function ComposerForm({
  orgSlug,
  workspaceSlug,
  draftKey,
  restored,
  transport: transportOverride,
}: {
  orgSlug: string;
  workspaceSlug: string;
  draftKey: string;
  restored: FeedbackDraft | null;
  transport?: AttachmentTransport;
}) {
  const router = useRouter();
  const { openPanel, closePanel } = usePanelContext();
  const [type, setType] = useState<FeedbackTypeValue>(restored?.type ?? "IDEA");
  const [title, setTitle] = useState(restored?.title ?? "");
  const [description, setDescription] = useState(restored?.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [titleInvalid, setTitleInvalid] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [isPending, startTransition] = useTransition();
  const dragDepth = useRef(0);
  const titleRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const typeRefs = useRef<Partial<Record<FeedbackTypeValue, HTMLButtonElement | null>>>({});
  const ids = useId();
  const shortcut = useSubmitShortcutLabel();

  const transport = useMemo(
    () => transportOverride ?? defaultAttachmentTransport(orgSlug, workspaceSlug),
    [transportOverride, orgSlug, workspaceSlug],
  );
  const uploads = useFeedbackAttachmentUploads({ transport, initial: restored?.attachments });
  const savedAttachments = useMemo(() => toDraftAttachments(uploads.items), [uploads.items]);

  const draft: FeedbackDraft = { type, title, description, attachments: savedAttachments };
  const draftEmpty = isFeedbackDraftEmpty(draft);
  const copy = FEEDBACK_COMPOSER_COPY[type];

  // Persist on every change. Cheap (one small JSON string) and it means a
  // reload, a closed tab or an accidental Esc never costs more than a keypress.
  useEffect(() => {
    saveFeedbackDraft(draftKey, { type, title, description, attachments: savedAttachments });
  }, [draftKey, type, title, description, savedAttachments]);

  useEffect(() => {
    // After the panel's own open animation/focus handling, put the caret in
    // the title — the first thing everyone types.
    const frame = requestAnimationFrame(() => {
      const input = titleRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const insertTemplate = () => {
    setDescription((current) => (current.trim() ? `${current.trimEnd()}\n\n${copy.template}` : copy.template));
  };

  const selectType = (next: FeedbackTypeValue, focus = false) => {
    setType(next);
    if (focus) typeRefs.current[next]?.focus();
  };

  const onTypeKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = FEEDBACK_TYPES.indexOf(type);
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % FEEDBACK_TYPES.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + FEEDBACK_TYPES.length) % FEEDBACK_TYPES.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = FEEDBACK_TYPES.length - 1;
    if (next === null) return;
    event.preventDefault();
    selectType(FEEDBACK_TYPES[next], true);
  };

  const discardDraft = () => {
    uploads.discardAll();
    // Empty the fields too, not just storage: the panel closes on the next
    // navigation, and until then the persist effect would re-save whatever
    // is still in state — resurrecting the draft the user just discarded.
    setTitle("");
    setDescription("");
    setType("IDEA");
    clearFeedbackDraft(draftKey);
    closePanel();
  };

  const blockedReason = uploads.uploading
    ? "Waiting for attachments to finish uploading…"
    : uploads.failed
      ? "Remove or retry the attachments marked with an error."
      : null;

  const submit = () => {
    if (isPending) return;
    if (!title.trim()) {
      setTitleInvalid(true);
      setError("Add a title so your team can scan this at a glance.");
      titleRef.current?.focus();
      return;
    }
    if (description.trim().length > FEEDBACK_DESCRIPTION_MAX_LENGTH) {
      setError(`Details must be ${FEEDBACK_DESCRIPTION_MAX_LENGTH.toLocaleString()} characters or fewer.`);
      return;
    }
    if (blockedReason) {
      setError(blockedReason);
      return;
    }
    setError(null);
    setTitleInvalid(false);

    startTransition(async () => {
      try {
        const result = await createFeedback(
          orgSlug,
          workspaceSlug,
          {
            title,
            description,
            type,
            attachments: savedAttachments.map(({ url, receipt }) => ({ url, receipt })),
          },
          `/${orgSlug}/${workspaceSlug}/feedback`,
        );
        if (!result.ok) {
          setError(result.error);
          if (result.attachmentUrl) {
            uploads.markFailed(result.attachmentUrl, "Couldn't verify this upload. Remove it or attach it again.");
          }
          return;
        }
        // The blobs now belong to the new item: forget them without deleting.
        uploads.reset();
        clearFeedbackDraft(draftKey);
        setTitle("");
        setDescription("");
        router.refresh();
        // Same slot, same history entry: the composer becomes the item.
        openPanel("feedback", result.item.id, { replace: true });
      } catch {
        setError("Couldn't submit right now. Your draft is saved on this device — try again.");
      }
    });
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    // The Markdown editor handles its own ⌘/Ctrl+Enter (and stops the event);
    // this covers the title field and every other control in the panel.
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLFormElement>) => {
    if (event.defaultPrevented) return; // the editor already took it
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    uploads.add(files);
  };

  const onDragEnter = (event: DragEvent<HTMLFormElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragOver = (event: DragEvent<HTMLFormElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (event: DragEvent<HTMLFormElement>) => {
    if (!hasFiles(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    dragDepth.current = 0;
    setDragging(false);
    if (event.defaultPrevented || !hasFiles(event)) return;
    event.preventDefault();
    uploads.add(event.dataTransfer.files);
  };

  const titleCountVisible = title.length > FEEDBACK_TITLE_MAX_LENGTH - 55;
  const descriptionCountVisible = description.length > FEEDBACK_DESCRIPTION_MAX_LENGTH * 0.9;
  const atAttachmentLimit = uploads.items.length >= FEEDBACK_ATTACHMENT_MAX_COUNT;

  const cancelButton = (
    <Button type="button" variant="ghost" size="sm" disabled={isPending}>
      Cancel
    </Button>
  );

  return (
    <form
      noValidate
      aria-label="New feedback"
      onSubmit={onSubmit}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className="relative flex min-h-0 flex-1 flex-col"
      data-slot="feedback-composer"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pt-4 pb-5">
        {restored && (
          <p role="status" className="-mb-2 text-xs text-text-subtle">
            Restored your unsent draft.
          </p>
        )}

        <div
          role="radiogroup"
          aria-label="Feedback type"
          className="grid grid-cols-2 gap-2"
        >
          {FEEDBACK_TYPES.map((value) => {
            const meta = FEEDBACK_TYPE_META[value];
            const Icon = TYPE_ICON[value];
            const selected = value === type;
            return (
              <button
                key={value}
                ref={(node) => {
                  typeRefs.current[value] = node;
                }}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                disabled={isPending}
                onClick={() => selectType(value)}
                onKeyDown={onTypeKeyDown}
                data-type={value}
                className={cn(
                  "group flex min-w-0 items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface-panel",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                  selected
                    ? "border-border-interactive bg-surface-card ring-1 ring-inset ring-border-interactive"
                    : "border-border-default bg-transparent hover:border-border-strong hover:bg-surface-inset",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-md transition-colors",
                    selected ? FEEDBACK_TONE_CLASS[meta.tone] : "bg-surface-inset text-text-subtle",
                  )}
                >
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-text-primary">{meta.label}</span>
                  <span className="block text-xs text-text-subtle">
                    {FEEDBACK_COMPOSER_COPY[value].description}
                  </span>
                </span>
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                    selected ? "border-primary bg-primary" : "border-border-strong",
                  )}
                >
                  {selected && <span className="size-1.5 rounded-full bg-primary-foreground" />}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={`${ids}-title`} className="sr-only">
            Title
          </label>
          <input
            ref={titleRef}
            id={`${ids}-title`}
            name="title"
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              if (titleInvalid && event.target.value.trim()) {
                setTitleInvalid(false);
                setError(null);
              }
            }}
            maxLength={FEEDBACK_TITLE_MAX_LENGTH}
            placeholder={type === "BUG" ? "What's broken?" : "What would make this better?"}
            aria-invalid={titleInvalid || undefined}
            aria-describedby={titleInvalid ? `${ids}-error` : undefined}
            disabled={isPending}
            autoComplete="off"
            className={cn(
              "w-full border-0 bg-transparent p-0 text-xl font-semibold leading-tight text-text-primary",
              "placeholder:text-text-disabled focus:outline-none focus-visible:outline-none",
              "disabled:opacity-60",
            )}
          />
          <div
            aria-hidden
            className={cn(
              "h-px w-full transition-colors",
              titleInvalid ? "bg-status-danger" : "bg-border-default",
            )}
          />
          {titleCountVisible && (
            <p className="text-right text-[11px] text-text-subtle" aria-live="polite">
              {title.length}/{FEEDBACK_TITLE_MAX_LENGTH}
            </p>
          )}
        </div>

        <div className="flex min-h-72 flex-1 flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span id={`${ids}-details`} className="text-xs font-medium text-text-secondary">
              Details <span className="font-normal text-text-subtle">· Markdown supported</span>
            </span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={insertTemplate}
              disabled={isPending}
              className="text-text-secondary"
            >
              <FileText aria-hidden />
              {copy.templateLabel}
            </Button>
          </div>
          <MarkdownDescriptionEditor
            value={description}
            onChange={setDescription}
            label="Details"
            placeholder={copy.placeholder}
            disabled={isPending}
            fill
            onFiles={uploads.add}
            footerNote={null}
          />
          {descriptionCountVisible && (
            <p
              className={cn(
                "text-right text-[11px]",
                description.length > FEEDBACK_DESCRIPTION_MAX_LENGTH ? "text-status-danger" : "text-text-subtle",
              )}
              aria-live="polite"
            >
              {description.length.toLocaleString()}/{FEEDBACK_DESCRIPTION_MAX_LENGTH.toLocaleString()}
            </p>
          )}
        </div>

        <section aria-labelledby={`${ids}-attachments`} className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h3 id={`${ids}-attachments`} className="text-xs font-medium text-text-secondary">
              Attachments
              {uploads.items.length > 0 && (
                <span className="font-normal text-text-subtle">
                  {" "}· {uploads.items.length}/{FEEDBACK_ATTACHMENT_MAX_COUNT}
                </span>
              )}
            </h3>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={FEEDBACK_ATTACHMENT_ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            data-testid="feedback-composer-file-input"
            onChange={(event) => {
              if (event.target.files) uploads.add(event.target.files);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isPending || atAttachmentLimit}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg border border-dashed border-border-strong px-3 py-3 text-left transition-colors",
              "hover:bg-surface-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-inset text-text-subtle">
              <Paperclip className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm text-text-primary">
                {atAttachmentLimit ? (
                  "Attachment limit reached"
                ) : (
                  <>
                    Drop files, paste a screenshot, or <span className="font-medium underline underline-offset-2">browse</span>
                  </>
                )}
              </span>
              <span className="block text-xs text-text-subtle">{FEEDBACK_ATTACHMENT_LIMITS_HINT}</span>
            </span>
          </button>

          {uploads.notice && (
            <p role="alert" className="flex items-start gap-1.5 text-xs text-status-danger">
              <AlertCircle aria-hidden className="mt-px size-3.5 shrink-0" />
              <span className="flex-1">{uploads.notice}</span>
              <button type="button" onClick={uploads.dismissNotice} className="text-text-subtle hover:text-text-primary" aria-label="Dismiss">
                <X aria-hidden className="size-3.5" />
              </button>
            </p>
          )}

          {uploads.items.length > 0 && (
            <ul className="flex flex-col gap-1.5" aria-label="Attached files">
              {uploads.items.map((item) => (
                <AttachmentChip
                  key={item.localId}
                  item={item}
                  disabled={isPending}
                  canRetry={uploads.canRetry(item.localId)}
                  onRemove={() => uploads.remove(item.localId)}
                  onRetry={() => uploads.retry(item.localId)}
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      <footer className="shrink-0 border-t border-border-default bg-surface-inset px-5 py-3">
        {error && (
          <p id={`${ids}-error`} role="alert" className="mb-2 flex items-start gap-1.5 text-xs text-status-danger">
            <AlertCircle aria-hidden className="mt-px size-3.5 shrink-0" />
            {error}
          </p>
        )}
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 truncate text-[11px] text-text-subtle" aria-live="polite">
            {isPending ? (
              "Submitting…"
            ) : blockedReason && !error ? (
              blockedReason
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
              <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={closePanel}>
                Cancel
              </Button>
            ) : (
              <ConfirmDialog
                trigger={cancelButton}
                title="Discard this draft?"
                description={
                  uploads.items.length
                    ? `Your title, details and ${uploads.items.length} attachment${uploads.items.length === 1 ? "" : "s"} will be deleted. Closing the panel instead keeps the draft.`
                    : "Your title and details will be deleted. Closing the panel instead keeps the draft."
                }
                confirmLabel="Discard draft"
                cancelLabel="Keep editing"
                destructive
                onConfirm={discardDraft}
              />
            )}
            <Button type="submit" size="sm" disabled={isPending || uploads.uploading}>
              {isPending ? "Submitting…" : "Submit"}
            </Button>
          </div>
        </div>
      </footer>

      {dragging && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-2 z-10 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border-interactive bg-surface-panel/90 text-sm font-medium text-text-primary"
        >
          <Upload className="size-5 text-text-subtle" />
          Drop to attach
        </div>
      )}
    </form>
  );
}

function AttachmentChip({
  item,
  disabled,
  canRetry,
  onRemove,
  onRetry,
}: {
  item: ComposerAttachment;
  disabled: boolean;
  canRetry: boolean;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const isImage = item.fileType.startsWith("image/");
  return (
    <li
      className={cn(
        "flex items-center gap-3 rounded-lg border bg-surface-card p-2",
        item.status === "error" ? "border-status-danger" : "border-border-default",
      )}
      data-status={item.status}
      data-testid="feedback-composer-attachment"
    >
      <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border-default bg-surface-inset">
        {isImage && item.previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.previewUrl} alt="" className="size-full object-cover" />
        ) : (
          <FileText aria-hidden className="size-4 text-text-subtle" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-text-primary" title={item.filename}>
          {item.filename}
        </span>
        {item.status === "uploading" ? (
          <span className="mt-1 flex items-center gap-2">
            <span
              role="progressbar"
              aria-label={`Uploading ${item.filename}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={item.progress}
              className="h-1 flex-1 overflow-hidden rounded-full bg-surface-inset"
            >
              <span
                className="block h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${Math.max(4, item.progress)}%` }}
              />
            </span>
            <span className="text-[11px] tabular-nums text-text-subtle">{item.progress}%</span>
          </span>
        ) : item.status === "error" ? (
          <span className="block truncate text-xs text-status-danger" role="alert">
            {item.error ?? "Upload failed."}
          </span>
        ) : (
          <span className="block text-xs text-text-subtle">{formatAttachmentSize(item.fileSize)}</span>
        )}
      </span>
      {item.status === "error" && canRetry && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onRetry}
          disabled={disabled}
          aria-label={`Retry ${item.filename}`}
          title="Retry upload"
        >
          <RotateCw aria-hidden />
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onRemove}
        disabled={disabled}
        aria-label={`Remove ${item.filename}`}
        title="Remove"
      >
        <X aria-hidden />
      </Button>
    </li>
  );
}
