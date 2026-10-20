"use client";

import * as React from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { parseTsv } from "./clipboard";
import {
  EMPTY_DRAFT_STATE,
  NOT_SENT_MESSAGE,
  UNCONFIRMED_MESSAGE,
  draftReducer,
  isBlankValues,
  pasteToDrafts,
  submitInChunks,
} from "./draft-rows";
import type { GridCreation, GridCreationField, GridDraftRow, GridDraftValues } from "./types";

const SELECT_CLASS =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive disabled:opacity-50";

type Props = {
  creation: GridCreation;
  /** Routes a message to the grid's polite live region. */
  announce: (message: string) => void;
  className?: string;
};

function newClientId(): string {
  return crypto.randomUUID();
}

/** "3 drafts", "1 draft". */
function countLabel(count: number, noun: { singular: string; plural: string }) {
  return `${count} ${count === 1 ? noun.singular : noun.plural}`;
}

/**
 * The draft area under a grid's rows.
 *
 * Drafts live in this component's own reducer, never in the grid's optimistic
 * `overrides`: those reset when `rows` changes identity, and a
 * `revalidatePath` after the first created chunk must not wipe the rest.
 *
 * The blank row at the end is a draft with a pre-generated id that is not yet in
 * the state. Typing promotes it under that same id and a fresh blank row takes
 * its place; because React keys by id, the input the user is typing in is the
 * same DOM node before and after, so focus survives the promotion.
 */
export function DraftArea({ creation, announce, className }: Props) {
  const [state, dispatch] = React.useReducer(draftReducer, EMPTY_DRAFT_STATE);
  const [ghostId, setGhostId] = React.useState(newClientId);
  const [submitting, setSubmitting] = React.useState(false);
  const [summary, setSummary] = React.useState("");
  const [pasteNotice, setPasteNotice] = React.useState("");
  const { drafts } = state;
  const defaults = React.useMemo(() => creation.makeValues(), [creation]);
  const noun = creation.noun;

  const ready = drafts.filter((draft) => draft.status !== "pending" && !isBlankValues(draft.values, defaults));
  const failing = drafts.filter((draft) => draft.status === "error").length;
  const hasWork = drafts.some((draft) => !isBlankValues(draft.values, defaults));

  // Unsaved drafts are lost on reload; make the browser ask first.
  React.useEffect(() => {
    if (!hasWork) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [hasWork]);

  const edit = (clientId: string, field: string, value: string) => {
    dispatch({ type: "edit", clientId, field, value });
  };

  const editGhost = (field: string, value: string) => {
    dispatch({ type: "add", rows: [{ clientId: ghostId, values: { ...creation.makeValues(), [field]: value } }] });
    setGhostId(newClientId());
    setSummary("");
  };

  const onPaste = (event: React.ClipboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    const fieldIndex = Number(target.closest<HTMLElement>("[data-field-index]")?.dataset.fieldIndex);
    if (!Number.isInteger(fieldIndex)) return;
    const text = event.clipboardData.getData("text/plain");
    // A single cell is an ordinary text paste into the focused input.
    if (!/[\t\r\n]/.test(text.replace(/[\r\n]+$/, ""))) return;
    event.preventDefault();
    const pasted = pasteToDrafts(parseTsv(text), creation, fieldIndex);
    if (pasted.length === 0) return;
    const room = Math.max(0, creation.maxRows - drafts.length);
    const accepted = pasted.slice(0, room);
    dispatch({
      type: "add",
      rows: accepted.map((values) => ({ clientId: newClientId(), values })),
    });
    setSummary("");
    const message =
      accepted.length < pasted.length
        ? `Added ${countLabel(accepted.length, noun)} of ${pasted.length}. The limit is ${creation.maxRows} at a time; import larger lists from CSV.`
        : `Added ${countLabel(accepted.length, noun)} from the clipboard.`;
    setPasteNotice(message);
    announce(message);
  };

  const create = async () => {
    if (submitting) return;
    const blanks = drafts.filter((draft) => draft.status !== "pending" && isBlankValues(draft.values, defaults));
    if (blanks.length > 0) dispatch({ type: "drop", clientIds: blanks.map((draft) => draft.clientId) });

    const invalid = new Map<string, Record<string, string>>();
    const sendable: GridDraftRow[] = [];
    for (const draft of ready) {
      const errors = creation.validate(draft.values);
      if (Object.keys(errors).length > 0) invalid.set(draft.clientId, errors);
      else sendable.push(draft);
    }
    if (invalid.size > 0) dispatch({ type: "invalid", errors: invalid });
    if (sendable.length === 0) {
      const message = invalid.size > 0 ? `Fix ${countLabel(invalid.size, noun)} before creating.` : "";
      setSummary(message);
      if (message) announce(message);
      return;
    }

    setSubmitting(true);
    setPasteNotice("");
    setSummary("");
    dispatch({ type: "pending", clientIds: sendable.map((draft) => draft.clientId) });
    const outcome = await submitInChunks(
      sendable.map((draft) => ({ clientId: draft.clientId, values: draft.values })),
      creation,
    );
    dispatch({ type: "settled", results: outcome.results });
    if (outcome.unconfirmed.length > 0) {
      dispatch({ type: "failed", clientIds: outcome.unconfirmed, message: outcome.requestError ?? UNCONFIRMED_MESSAGE });
    }
    if (outcome.unsent.length > 0) dispatch({ type: "failed", clientIds: outcome.unsent, message: NOT_SENT_MESSAGE });
    setSubmitting(false);

    const created = outcome.results.filter((result) => result.ok).length;
    const problems = sendable.length - created + invalid.size;
    const message =
      problems === 0
        ? `Created ${countLabel(created, noun)}.`
        : `Created ${created} of ${sendable.length + invalid.size}. ${countLabel(problems, noun)} need attention.`;
    setSummary(message);
    announce(message);
  };

  const columnTemplate = creation.fields
    .map((field) => field.width ?? "minmax(9rem, 1fr)")
    .concat("2rem")
    .join(" ");

  const rows: { clientId: string; values: GridDraftValues; draft: GridDraftRow | null }[] = [
    ...drafts.map((draft) => ({ clientId: draft.clientId, values: draft.values, draft })),
    { clientId: ghostId, values: defaults, draft: null },
  ];

  return (
    <section
      aria-label={`Add ${noun.plural}`}
      data-testid="grid-draft-area"
      className={cn("shrink-0 border-t border-dashed border-border-default bg-surface-inset/40", className)}
      onPaste={onPaste}
    >
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-text-secondary">
        <span className="font-medium" data-testid="draft-status">
          {hasWork
            ? `${countLabel(ready.length, noun)} ready${failing > 0 ? `, ${failing} with errors` : ""}`
            : `Add ${noun.plural}: type below or paste rows from a spreadsheet.`}
        </span>
        {summary && (
          <span role="status" data-testid="draft-summary">
            {summary}
          </span>
        )}
        {pasteNotice && (
          <span role="status" data-testid="draft-paste-notice">
            {pasteNotice}
          </span>
        )}
        <span className="flex-1" />
        {hasWork && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={submitting}
              data-testid="draft-discard"
              onClick={() => {
                dispatch({ type: "discard" });
                setSummary("");
                setPasteNotice("");
              }}
            >
              Discard
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={submitting || ready.length === 0}
              data-testid="draft-create"
              onClick={() => void create()}
            >
              {submitting ? "Creating..." : `Create ${ready.length}`}
            </Button>
          </>
        )}
      </div>

      <div className="max-h-72 overflow-auto px-3 pb-3">
        <div role="table" aria-label={`New ${noun.plural}`} className="min-w-fit space-y-1">
          <div role="row" className="grid items-center gap-2 text-xs font-medium text-text-subtle" style={{ gridTemplateColumns: columnTemplate }}>
            {creation.fields.map((field) => (
              <div key={field.id} role="columnheader">
                {field.label}
              </div>
            ))}
            <div role="columnheader" className="sr-only">
              Actions
            </div>
          </div>
          {rows.map(({ clientId, values, draft }, index) => (
            <DraftRowView
              key={clientId}
              fields={creation.fields}
              columnTemplate={columnTemplate}
              index={index}
              values={values}
              draft={draft}
              addLabel={creation.addLabel ?? `Add ${noun.singular}...`}
              noun={noun}
              onEdit={(field, value) => (draft ? edit(clientId, field, value) : editGhost(field, value))}
              onRemove={() => dispatch({ type: "remove", clientId })}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function DraftRowView({
  fields,
  columnTemplate,
  index,
  values,
  draft,
  addLabel,
  noun,
  onEdit,
  onRemove,
}: {
  fields: readonly GridCreationField[];
  columnTemplate: string;
  index: number;
  values: GridDraftValues;
  draft: GridDraftRow | null;
  addLabel: string;
  noun: { singular: string; plural: string };
  onEdit: (field: string, value: string) => void;
  onRemove: () => void;
}) {
  const pending = draft?.status === "pending";
  const rowLabel = `${noun.singular} draft ${index + 1}`;
  return (
    <div
      role="row"
      data-testid={draft ? "draft-row" : "draft-row-blank"}
      data-status={draft?.status ?? "blank"}
      data-pending={pending ? "true" : undefined}
      className={cn("space-y-0.5", pending && "opacity-60")}
    >
      <div className="grid items-start gap-2" style={{ gridTemplateColumns: columnTemplate }}>
        {fields.map((field, fieldIndex) => {
          const error = draft?.fieldErrors[field.id];
          const errorId = error ? `${rowLabel}-${field.id}-error`.replace(/\s+/g, "-") : undefined;
          const label = `${field.label} for ${rowLabel}`;
          return (
            <div key={field.id} role="cell" data-field-index={fieldIndex} className="min-w-0">
              {field.kind === "select" ? (
                <select
                  aria-label={label}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={errorId}
                  className={SELECT_CLASS}
                  value={values[field.id] ?? ""}
                  disabled={pending}
                  data-testid={`draft-field-${field.id}`}
                  onChange={(event) => onEdit(field.id, event.target.value)}
                >
                  {!field.options?.some((option) => option.value === (values[field.id] ?? "")) && (
                    <option value={values[field.id] ?? ""}>{values[field.id] || "None"}</option>
                  )}
                  {field.options?.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  aria-label={label}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={errorId}
                  // The blank row carries the "add" prompt on its first field only.
                  placeholder={!draft && fieldIndex === 0 ? addLabel : undefined}
                  value={values[field.id] ?? ""}
                  readOnly={pending}
                  data-testid={`draft-field-${field.id}`}
                  onChange={(event) => onEdit(field.id, event.target.value)}
                />
              )}
              {error && (
                <p id={errorId} className="mt-0.5 text-xs text-status-danger" data-testid="draft-field-error">
                  {error}
                </p>
              )}
            </div>
          );
        })}
        <div role="cell" className="flex h-8 items-center">
          {draft && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove ${rowLabel}`}
              disabled={pending}
              onClick={onRemove}
            >
              <Trash2 />
            </Button>
          )}
        </div>
      </div>
      {draft?.rowError && (
        <p role="alert" className="text-xs text-status-danger" data-testid="draft-row-error">
          {draft.rowError}
        </p>
      )}
    </div>
  );
}
