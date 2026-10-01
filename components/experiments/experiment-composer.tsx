"use client";

import { useEffect, useId, useMemo, useRef, useState, useTransition, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";

import {
  createExperimentFromComposer,
  loadExperimentComposerOptions,
  type ExperimentComposerOptions,
} from "@/app/[orgSlug]/[workspaceSlug]/experiments/actions";
import {
  ComposerFooter,
  ComposerRestoredNotice,
  ComposerTitleField,
  isSubmitShortcut,
  useFocusOnOpen,
  useRestoredDraft,
} from "@/components/composer/composer-parts";
import { usePanelContext } from "@/components/panels/panel-context";
import { Combobox, ComboboxContent, ComboboxTrigger, ComboboxValue } from "@/components/ui/combobox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  EXPERIMENT_TITLE_MAX_LENGTH,
  clearExperimentDraft,
  experimentDraftKey,
  isExperimentDraftEmpty,
  loadExperimentDraft,
  presetAssumptionFromComposerId,
  saveExperimentDraft,
  type ExperimentDraft,
} from "@/lib/experiment-draft";

const NO_SQUAD = "__none__";
const NO_ASSUMPTION = "__none__";

type OptionsState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; options: ExperimentComposerOptions };

export type ExperimentComposerProps = {
  orgSlug: string;
  workspaceSlug: string;
  /** The panel id: `new`, or `new-<assumptionId>` to preselect an assumption. */
  composerId: string;
};

/**
 * The "New experiment" composer, rendered by PanelShell in the detail-panel
 * slot (`?detail=experiment-new:new`). It follows the feedback and opportunity
 * composers' conventions — shared through components/composer — and on submit
 * becomes the created experiment's panel.
 */
export function ExperimentComposer({ orgSlug, workspaceSlug, composerId }: ExperimentComposerProps) {
  const draftKey = experimentDraftKey(orgSlug, workspaceSlug);
  const initial = useRestoredDraft(draftKey, loadExperimentDraft);

  if (!initial) return <div className="flex-1" aria-busy="true" />;
  return (
    <ComposerForm
      key={draftKey}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      draftKey={draftKey}
      restored={initial.draft}
      presetAssumptionId={presetAssumptionFromComposerId(composerId)}
    />
  );
}

function ComposerForm({
  orgSlug,
  workspaceSlug,
  draftKey,
  restored,
  presetAssumptionId,
}: {
  orgSlug: string;
  workspaceSlug: string;
  draftKey: string;
  restored: ExperimentDraft | null;
  presetAssumptionId: string | null;
}) {
  const router = useRouter();
  const { openPanel, closePanel } = usePanelContext();
  const [title, setTitle] = useState(restored?.title ?? "");
  const [hypothesis, setHypothesis] = useState(restored?.hypothesis ?? "");
  const [method, setMethod] = useState(restored?.method ?? "");
  const [killCondition, setKillCondition] = useState(restored?.killCondition ?? "");
  const [squadId, setSquadId] = useState<string | null>(restored?.squadId ?? null);
  // A "Test this assumption" link is an explicit choice made just now, so it
  // wins over the assumption saved with an older draft.
  const [assumptionId, setAssumptionId] = useState<string | null>(presetAssumptionId ?? restored?.assumptionId ?? null);
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [optionsState, setOptionsState] = useState<OptionsState>({ status: "loading" });
  const [isPending, startTransition] = useTransition();
  const titleRef = useRef<HTMLInputElement>(null);
  const ids = useId();

  useEffect(() => {
    let cancelled = false;
    loadExperimentComposerOptions(orgSlug, workspaceSlug)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setOptionsState({ status: "error" });
          return;
        }
        const { options } = result;
        setOptionsState({ status: "ready", options });
        // A restored draft can point at a squad or assumption deleted since.
        setSquadId((id) => (id && options.squads.some((squad) => squad.id === id) ? id : null));
        setAssumptionId((id) => (id && options.assumptions.some((a) => a.id === id) ? id : null));
      })
      .catch(() => {
        if (!cancelled) setOptionsState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [orgSlug, workspaceSlug]);

  const draft: ExperimentDraft = { title, hypothesis, method, killCondition, squadId, assumptionId };
  const draftEmpty = isExperimentDraftEmpty(draft);

  useEffect(() => {
    saveExperimentDraft(draftKey, { title, hypothesis, method, killCondition, squadId, assumptionId });
  }, [draftKey, title, hypothesis, method, killCondition, squadId, assumptionId]);

  useFocusOnOpen(titleRef);

  const options = optionsState.status === "ready" ? optionsState.options : null;

  const resetFields = () => {
    setTitle("");
    setHypothesis("");
    setMethod("");
    setKillCondition("");
    setSquadId(null);
    setAssumptionId(null);
  };

  const discardDraft = () => {
    // Empty the fields too, not just storage: until the panel closes the
    // persist effect would re-save whatever is still in state.
    resetFields();
    clearExperimentDraft(draftKey);
    closePanel();
  };

  const clearInvalid = (field: string) =>
    setInvalid((current) => {
      if (!current.has(field)) return current;
      const next = new Set(current);
      next.delete(field);
      if (next.size === 0) setError(null);
      return next;
    });

  const submit = () => {
    if (isPending) return;
    const missing = [
      !title.trim() && "title",
      !hypothesis.trim() && "hypothesis",
      !method.trim() && "method",
      !killCondition.trim() && "killCondition",
    ].filter((field): field is string => Boolean(field));
    if (missing.length > 0) {
      setInvalid(new Set(missing));
      setError(
        missing.includes("title")
          ? "Add a title so your team can scan this at a glance."
          : "Hypothesis, method and kill condition are all required.",
      );
      if (missing.includes("title")) titleRef.current?.focus();
      return;
    }
    setError(null);
    setInvalid(new Set());

    startTransition(async () => {
      try {
        const result = await createExperimentFromComposer(orgSlug, workspaceSlug, {
          title,
          hypothesis,
          method,
          killCondition,
          assumptionId,
          squadId,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        clearExperimentDraft(draftKey);
        resetFields();
        router.refresh();
        // Same slot, same history entry: the composer becomes the experiment.
        openPanel("experiment", result.experiment.id, { replace: true });
      } catch {
        setError("Couldn't create the experiment right now. Your draft is saved on this device — try again.");
      }
    });
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (isSubmitShortcut(event)) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form
      noValidate
      aria-label="New experiment"
      onSubmit={onSubmit}
      onKeyDown={onKeyDown}
      className="relative flex min-h-0 flex-1 flex-col"
      data-slot="experiment-composer"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pt-4 pb-5">
        {restored && <ComposerRestoredNotice />}

        <ComposerTitleField
          inputRef={titleRef}
          id={`${ids}-title`}
          value={title}
          onChange={(value) => {
            setTitle(value);
            if (value.trim()) clearInvalid("title");
          }}
          maxLength={EXPERIMENT_TITLE_MAX_LENGTH}
          placeholder="What are you testing?"
          invalid={invalid.has("title")}
          errorId={`${ids}-error`}
          disabled={isPending}
        />

        <TextField
          id={`${ids}-hypothesis`}
          label="Hypothesis"
          value={hypothesis}
          onChange={(value) => {
            setHypothesis(value);
            if (value.trim()) clearInvalid("hypothesis");
          }}
          placeholder="We believe that…"
          invalid={invalid.has("hypothesis")}
          disabled={isPending}
        />

        <TextField
          id={`${ids}-method`}
          label="Method"
          value={method}
          onChange={(value) => {
            setMethod(value);
            if (value.trim()) clearInvalid("method");
          }}
          placeholder="We will test this by…"
          invalid={invalid.has("method")}
          disabled={isPending}
        />

        <TextField
          id={`${ids}-kill`}
          label={
            <>
              <AlertTriangle aria-hidden className="size-3.5 text-status-warning" />
              Kill Condition
            </>
          }
          value={killCondition}
          onChange={(value) => {
            setKillCondition(value);
            if (value.trim()) clearInvalid("killCondition");
          }}
          placeholder="We will kill this experiment if…"
          invalid={invalid.has("killCondition")}
          disabled={isPending}
          rows={2}
          hint="Define the hard gate before you start. It is shown prominently during the experiment."
        />

        {optionsState.status === "loading" && (
          <p className="text-xs text-text-subtle" aria-busy="true">
            Loading assumptions and squads…
          </p>
        )}
        {optionsState.status === "error" && (
          <p className="text-xs text-text-subtle">
            Couldn&apos;t load assumptions and squads. You can still create the experiment and link them afterwards.
          </p>
        )}
        {options && options.assumptions.length > 0 && (
          <AssumptionField
            id={`${ids}-assumption`}
            assumptions={options.assumptions}
            value={assumptionId}
            onChange={setAssumptionId}
            disabled={isPending}
          />
        )}
        {options && options.squads.length > 0 && (
          <SquadField
            id={`${ids}-squad`}
            squads={options.squads}
            value={squadId}
            onChange={setSquadId}
            disabled={isPending}
          />
        )}
      </div>

      <ComposerFooter
        error={error}
        errorId={`${ids}-error`}
        isPending={isPending}
        draftEmpty={draftEmpty}
        onClose={closePanel}
        discardDescription="Your title, hypothesis, method and links will be deleted. Closing the panel instead keeps the draft."
        onDiscard={discardDraft}
        submitDisabled={isPending}
      />
    </form>
  );
}

function FieldLabel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <span id={id} className="text-xs font-medium text-text-secondary">
      {children}
    </span>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  placeholder,
  invalid,
  disabled,
  rows = 4,
  hint,
}: {
  id: string;
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  invalid: boolean;
  disabled: boolean;
  rows?: number;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
        {label}
      </label>
      <Textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        aria-invalid={invalid || undefined}
      />
      {hint && <p className="text-xs text-text-subtle">{hint}</p>}
    </div>
  );
}

function AssumptionField({
  id,
  assumptions,
  value,
  onChange,
  disabled,
}: {
  id: string;
  assumptions: ExperimentComposerOptions["assumptions"];
  value: string | null;
  onChange: (value: string | null) => void;
  disabled: boolean;
}) {
  const items = useMemo(
    () => [
      { value: NO_ASSUMPTION, label: "No assumption" },
      ...assumptions.map((a) => ({
        value: a.id,
        label: a.title,
        render: (
          <span className="flex flex-col items-start">
            <span className="text-xs leading-tight text-muted-foreground">
              {a.opportunityTitle} / {a.solutionTitle}
            </span>
            <span>{a.title}</span>
          </span>
        ),
      })),
    ],
    [assumptions],
  );
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel id={id}>
        Testing assumption <span className="font-normal text-text-subtle">· optional</span>
      </FieldLabel>
      <Combobox
        items={items}
        value={value ?? NO_ASSUMPTION}
        onValueChange={(next) => onChange(!next || next === NO_ASSUMPTION ? null : next)}
        disabled={disabled}
      >
        <ComboboxTrigger aria-labelledby={id} className="w-full">
          <ComboboxValue placeholder="No assumption" />
        </ComboboxTrigger>
        <ComboboxContent align="start" inputPlaceholder="Search assumptions…" emptyMessage="No assumptions found." />
      </Combobox>
      <p className="text-xs text-text-subtle">
        Concluding the experiment will update this assumption&apos;s validated/invalidated status.
      </p>
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
  squads: ExperimentComposerOptions["squads"];
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
      <FieldLabel id={id}>
        Squad <span className="font-normal text-text-subtle">· optional</span>
      </FieldLabel>
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
