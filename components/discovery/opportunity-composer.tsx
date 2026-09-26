"use client";

import { useEffect, useId, useMemo, useRef, useState, useTransition, type FormEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Bug, Lightbulb, X } from "lucide-react";

import {
  createOpportunityFromComposer,
  loadOpportunityComposerOptions,
  type OpportunityComposerOptions,
} from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import {
  ComposerFooter,
  ComposerMarkdownField,
  ComposerRestoredNotice,
  ComposerTitleField,
  appendTemplate,
  isSubmitShortcut,
  useFocusOnOpen,
  useRestoredDraft,
} from "@/components/composer/composer-parts";
import { NO_KEY_RESULT, keyResultComboboxItems } from "@/components/discovery/key-result-options";
import { usePanelContext } from "@/components/panels/panel-context";
import {
  Combobox,
  ComboboxContent,
  ComboboxMultiple,
  ComboboxTrigger,
  ComboboxValue,
  type ComboboxItemData,
} from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FEEDBACK_STATUS_META, type FeedbackStatus } from "@/lib/feedback-meta";
import {
  NEW_OPPORTUNITY_STATUSES,
  OPPORTUNITY_SEED_FEEDBACK_MAX,
  OPPORTUNITY_SEGMENT_MAX_LENGTH,
  OPPORTUNITY_TITLE_MAX_LENGTH,
  clearOpportunityDraft,
  isNewOpportunityStatus,
  isOpportunityDraftEmpty,
  loadOpportunityDraft,
  opportunityDraftKey,
  presetStatusFromComposerId,
  saveOpportunityDraft,
  type NewOpportunityStatus,
  type OpportunityDraft,
} from "@/lib/opportunity-draft";

export const OPPORTUNITY_OUTLINE =
  "## Who's affected\n\n\n\n## Current pain\n\n\n\n## Evidence\n\n\n\n## Desired outcome\n\n";

const STATUS_LABELS: Record<NewOpportunityStatus, string> = {
  EXPLORING: "Exploring",
  VALIDATING: "Validating",
  PRIORITIZED: "Prioritized",
  ACTIVE: "Active",
};

const NO_SQUAD = "__none__";

type OptionsState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; options: OpportunityComposerOptions };

export type OpportunityComposerProps = {
  orgSlug: string;
  workspaceSlug: string;
  /** The panel id: `new`, or `new-<status>` to preset a board column's status. */
  composerId: string;
};

/**
 * The "New opportunity" composer, rendered by PanelShell in the detail-panel
 * slot (`?detail=opportunity-new:new`, or `:new-<status>` from a board
 * column). It follows the feedback composer's conventions — shared through
 * components/composer — and on submit becomes the created opportunity's panel.
 */
export function OpportunityComposer({ orgSlug, workspaceSlug, composerId }: OpportunityComposerProps) {
  const draftKey = opportunityDraftKey(orgSlug, workspaceSlug);
  const initial = useRestoredDraft(draftKey, loadOpportunityDraft);

  if (!initial) return <div className="flex-1" aria-busy="true" />;
  return (
    <ComposerForm
      key={draftKey}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      draftKey={draftKey}
      restored={initial.draft}
      presetStatus={presetStatusFromComposerId(composerId)}
    />
  );
}

function ComposerForm({
  orgSlug,
  workspaceSlug,
  draftKey,
  restored,
  presetStatus,
}: {
  orgSlug: string;
  workspaceSlug: string;
  draftKey: string;
  restored: OpportunityDraft | null;
  presetStatus: NewOpportunityStatus | null;
}) {
  const router = useRouter();
  const { openPanel, closePanel } = usePanelContext();
  const [title, setTitle] = useState(restored?.title ?? "");
  const [description, setDescription] = useState(restored?.description ?? "");
  const [customerSegment, setCustomerSegment] = useState(restored?.customerSegment ?? "");
  // A column's preset is an explicit choice made just now, so it wins over the
  // status saved with an older draft.
  const [status, setStatus] = useState<NewOpportunityStatus>(presetStatus ?? restored?.status ?? "EXPLORING");
  const [squadId, setSquadId] = useState<string | null>(restored?.squadId ?? null);
  const [keyResultId, setKeyResultId] = useState<string | null>(restored?.keyResultId ?? null);
  const [feedbackIds, setFeedbackIds] = useState<string[]>(restored?.feedbackIds ?? []);
  const [error, setError] = useState<string | null>(null);
  const [titleInvalid, setTitleInvalid] = useState(false);
  const [optionsState, setOptionsState] = useState<OptionsState>({ status: "loading" });
  const [isPending, startTransition] = useTransition();
  const titleRef = useRef<HTMLInputElement>(null);
  const ids = useId();

  // Opening another column's "Add opportunity" while the composer is already
  // open changes only the preset; keep everything typed so far.
  const [appliedPreset, setAppliedPreset] = useState(presetStatus);
  if (presetStatus !== appliedPreset) {
    setAppliedPreset(presetStatus);
    if (presetStatus) setStatus(presetStatus);
  }

  useEffect(() => {
    let cancelled = false;
    loadOpportunityComposerOptions(orgSlug, workspaceSlug)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setOptionsState({ status: "error" });
          return;
        }
        const { options } = result;
        setOptionsState({ status: "ready", options });
        // A restored draft can point at a squad, KR or feedback item deleted
        // since. Drop those rather than failing the submit on them.
        setSquadId((id) => (id && options.squads.some((squad) => squad.id === id) ? id : null));
        setKeyResultId((id) => (id && options.keyResults.some((kr) => kr.id === id) ? id : null));
        setFeedbackIds((selected) => selected.filter((id) => options.feedback.some((item) => item.id === id)));
      })
      .catch(() => {
        if (!cancelled) setOptionsState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [orgSlug, workspaceSlug]);

  const draft: OpportunityDraft = { title, description, customerSegment, status, squadId, keyResultId, feedbackIds };
  const draftEmpty = isOpportunityDraftEmpty(draft);

  useEffect(() => {
    saveOpportunityDraft(draftKey, { title, description, customerSegment, status, squadId, keyResultId, feedbackIds });
  }, [draftKey, title, description, customerSegment, status, squadId, keyResultId, feedbackIds]);

  useFocusOnOpen(titleRef);

  const options = optionsState.status === "ready" ? optionsState.options : null;

  const resetFields = () => {
    setTitle("");
    setDescription("");
    setCustomerSegment("");
    setSquadId(null);
    setKeyResultId(null);
    setFeedbackIds([]);
  };

  const discardDraft = () => {
    // Empty the fields too, not just storage: until the panel closes the
    // persist effect would re-save whatever is still in state.
    resetFields();
    clearOpportunityDraft(draftKey);
    closePanel();
  };

  const submit = () => {
    if (isPending) return;
    if (!title.trim()) {
      setTitleInvalid(true);
      setError("Add a title so your team can scan this at a glance.");
      titleRef.current?.focus();
      return;
    }
    setError(null);
    setTitleInvalid(false);

    startTransition(async () => {
      try {
        const result = await createOpportunityFromComposer(orgSlug, workspaceSlug, {
          title,
          description,
          customerSegment,
          status,
          squadId,
          linkedKeyResultId: keyResultId,
          feedbackIds,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        clearOpportunityDraft(draftKey);
        resetFields();
        router.refresh();
        // Same slot, same history entry: the composer becomes the opportunity.
        openPanel("opportunity", result.opportunity.id, { replace: true });
      } catch {
        setError("Couldn't create the opportunity right now. Your draft is saved on this device — try again.");
      }
    });
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    // The Markdown editor handles its own ⌘/Ctrl+Enter (and stops the event);
    // this covers the title and every other control in the panel.
    if (isSubmitShortcut(event)) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form
      noValidate
      aria-label="New opportunity"
      onSubmit={onSubmit}
      onKeyDown={onKeyDown}
      className="relative flex min-h-0 flex-1 flex-col"
      data-slot="opportunity-composer"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pt-4 pb-5">
        {restored && <ComposerRestoredNotice />}

        <ComposerTitleField
          inputRef={titleRef}
          id={`${ids}-title`}
          value={title}
          onChange={(value) => {
            setTitle(value);
            if (titleInvalid && value.trim()) {
              setTitleInvalid(false);
              setError(null);
            }
          }}
          maxLength={OPPORTUNITY_TITLE_MAX_LENGTH}
          placeholder="What opportunity have you discovered?"
          invalid={titleInvalid}
          errorId={`${ids}-error`}
          disabled={isPending}
        />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <StatusField id={`${ids}-status`} value={status} onChange={setStatus} disabled={isPending} />
          {options && options.squads.length > 0 && (
            <SquadField
              id={`${ids}-squad`}
              squads={options.squads}
              value={squadId}
              onChange={setSquadId}
              disabled={isPending}
            />
          )}
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <label htmlFor={`${ids}-segment`} className="text-xs font-medium text-text-secondary">
              Customer segment <span className="font-normal text-text-subtle">· optional</span>
            </label>
            <Input
              id={`${ids}-segment`}
              value={customerSegment}
              onChange={(event) => setCustomerSegment(event.target.value)}
              maxLength={OPPORTUNITY_SEGMENT_MAX_LENGTH}
              placeholder="e.g. Enterprise buyers, SMB ops teams"
              disabled={isPending}
              autoComplete="off"
            />
          </div>
        </div>

        <ComposerMarkdownField
          labelId={`${ids}-description`}
          label="Description"
          value={description}
          onChange={setDescription}
          placeholder="Who has this problem, what does it cost them today, and what evidence do you have?"
          disabled={isPending}
          templateLabel="Insert opportunity outline"
          onInsertTemplate={() => setDescription((current) => appendTemplate(current, OPPORTUNITY_OUTLINE))}
        />

        {optionsState.status === "loading" && (
          <p className="text-xs text-text-subtle" aria-busy="true">
            Loading key results and feedback…
          </p>
        )}
        {optionsState.status === "error" && (
          <p className="text-xs text-text-subtle">
            Couldn&apos;t load key results and feedback. You can still create the opportunity and link them from its
            panel afterwards.
          </p>
        )}
        {options && (
          <>
            <KeyResultField
              id={`${ids}-kr`}
              keyResults={options.keyResults}
              value={keyResultId}
              onChange={setKeyResultId}
              disabled={isPending}
            />
            <FeedbackSeedField
              id={`${ids}-feedback`}
              feedback={options.feedback}
              value={feedbackIds}
              onChange={setFeedbackIds}
              disabled={isPending}
            />
          </>
        )}
      </div>

      <ComposerFooter
        error={error}
        errorId={`${ids}-error`}
        isPending={isPending}
        draftEmpty={draftEmpty}
        onClose={closePanel}
        discardDescription="Your title, description and links will be deleted. Closing the panel instead keeps the draft."
        onDiscard={discardDraft}
        submitDisabled={isPending}
      />
    </form>
  );
}

function FieldLabel({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <span id={id} className="text-xs font-medium text-text-secondary">
      {children}
    </span>
  );
}

function StatusField({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: NewOpportunityStatus;
  onChange: (value: NewOpportunityStatus) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel id={id}>Status</FieldLabel>
      <Select
        value={value}
        onValueChange={(next: string | null) => {
          if (isNewOpportunityStatus(next)) onChange(next);
        }}
        disabled={disabled}
        items={STATUS_LABELS}
      >
        <SelectTrigger aria-labelledby={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {NEW_OPPORTUNITY_STATUSES.map((status) => (
            <SelectItem key={status} value={status}>
              {STATUS_LABELS[status]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function SquadField({
  id,
  squads,
  value,
  onChange,
  disabled,
}: {
  id: string;
  squads: OpportunityComposerOptions["squads"];
  value: string | null;
  onChange: (value: string | null) => void;
  disabled: boolean;
}) {
  // Each option renders a colour dot beside the name, so Select cannot derive
  // a text label from the children (see components/ui/select.tsx). Without
  // `items`, the trigger would show the raw squad UUID.
  const items = useMemo(
    () => ({ [NO_SQUAD]: "No squad", ...Object.fromEntries(squads.map((squad) => [squad.id, squad.name])) }),
    [squads],
  );
  const selected = squads.find((squad) => squad.id === value);
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel id={id}>Squad</FieldLabel>
      <Select
        value={value ?? NO_SQUAD}
        onValueChange={(next: string | null) => onChange(!next || next === NO_SQUAD ? null : next)}
        disabled={disabled}
        items={items}
      >
        <SelectTrigger aria-labelledby={id} className="w-full">
          {selected && (
            <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: selected.color }} />
          )}
          <SelectValue placeholder="No squad" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_SQUAD}>No squad</SelectItem>
          {squads.map((squad) => (
            <SelectItem key={squad.id} value={squad.id}>
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: squad.color }} />
                {squad.name}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function KeyResultField({
  id,
  keyResults,
  value,
  onChange,
  disabled,
}: {
  id: string;
  keyResults: OpportunityComposerOptions["keyResults"];
  value: string | null;
  onChange: (value: string | null) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel id={id}>
        Driving key result <span className="font-normal text-text-subtle">· optional</span>
      </FieldLabel>
      {keyResults.length === 0 ? (
        <p className="text-xs text-text-subtle">No key results in this workspace yet.</p>
      ) : (
        <Combobox
          items={keyResultComboboxItems(keyResults)}
          // null (not the "None" item) while nothing is linked, so the trigger
          // shows its call-to-action placeholder instead of "— None —".
          value={value}
          onValueChange={(next) => onChange(!next || next === NO_KEY_RESULT ? null : next)}
          disabled={disabled}
        >
          <ComboboxTrigger aria-label="Key result" className="w-full">
            <ComboboxValue placeholder="Link a key result" />
          </ComboboxTrigger>
          <ComboboxContent align="start" inputPlaceholder="Search key results…" emptyMessage="No matching key results." />
        </Combobox>
      )}
    </div>
  );
}

function feedbackItem(item: OpportunityComposerOptions["feedback"][number]): ComboboxItemData {
  const Icon = item.type === "BUG" ? Bug : Lightbulb;
  const status = FEEDBACK_STATUS_META[item.status as FeedbackStatus]?.label ?? item.status;
  return {
    value: item.id,
    // `label` is what the list filters on, so it stays the plain title.
    label: item.title,
    // ComboboxItem does not let its content shrink, so bound the row to the
    // popup's width (minus the check-mark gutter) for the text to truncate
    // instead of running under the check mark.
    render: (
      <span className="flex w-[calc(var(--anchor-width)-3.5rem)] min-w-0 items-center gap-1.5">
        <Icon aria-hidden className="size-3.5 shrink-0 text-text-subtle" />
        <span className="min-w-0 truncate">{item.title}</span>
        <span className="min-w-0 max-w-[50%] shrink-0 truncate text-xs text-text-subtle">
          · {item.opportunity ? `linked to ${item.opportunity.title}` : status}
        </span>
      </span>
    ),
  };
}

function FeedbackSeedField({
  id,
  feedback,
  value,
  onChange,
  disabled,
}: {
  id: string;
  feedback: OpportunityComposerOptions["feedback"];
  value: string[];
  onChange: (value: string[]) => void;
  disabled: boolean;
}) {
  const items = useMemo(() => feedback.map(feedbackItem), [feedback]);
  const byId = useMemo(() => new Map(feedback.map((item) => [item.id, item])), [feedback]);
  const selected = value.map((feedbackId) => byId.get(feedbackId)).filter((item) => item !== undefined);
  const relinking = selected.filter((item) => item.opportunity).length;

  return (
    <section aria-labelledby={id} className="flex flex-col gap-1.5">
      <FieldLabel id={id}>
        Seed from feedback <span className="font-normal text-text-subtle">· optional</span>
      </FieldLabel>
      {feedback.length === 0 ? (
        <p className="text-xs text-text-subtle">No feedback in this workspace yet.</p>
      ) : (
        <>
          <ComboboxMultiple
            items={items}
            values={value}
            // The server refuses more than this; stop the picker at the same place.
            onValuesChange={(next) => onChange(next.slice(0, OPPORTUNITY_SEED_FEEDBACK_MAX))}
            disabled={disabled}
          >
            <ComboboxTrigger aria-label="Seed from feedback" className="w-full">
              <span className="flex-1 text-left text-muted-foreground">
                {value.length ? `${value.length} selected — add more` : "Link feedback that points to this opportunity"}
              </span>
            </ComboboxTrigger>
            <ComboboxContent align="start" inputPlaceholder="Search feedback…" emptyMessage="No matching feedback." />
          </ComboboxMultiple>
          {selected.length > 0 && (
            <ul aria-label="Selected feedback" className="flex flex-col gap-1">
              {selected.map((item) => {
                const Icon = item.type === "BUG" ? Bug : Lightbulb;
                return (
                  <li
                    key={item.id}
                    className="flex items-center gap-2 rounded-md border border-border-default bg-surface-card py-1 pr-1 pl-2 text-sm"
                  >
                    <Icon aria-hidden className="size-3.5 shrink-0 text-text-subtle" />
                    <span className="min-w-0 flex-1 truncate text-text-primary" title={item.title}>
                      {item.title}
                    </span>
                    <button
                      type="button"
                      onClick={() => onChange(value.filter((feedbackId) => feedbackId !== item.id))}
                      disabled={disabled}
                      aria-label={`Remove ${item.title}`}
                      className="shrink-0 rounded p-0.5 text-text-subtle transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    >
                      <X aria-hidden className="size-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {relinking > 0 && (
            <p className="text-xs text-text-subtle">
              {relinking === 1
                ? "1 is linked to another opportunity and will move here."
                : `${relinking} are linked to other opportunities and will move here.`}
            </p>
          )}
        </>
      )}
    </section>
  );
}
