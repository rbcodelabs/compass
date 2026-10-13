"use client";

import { useEffect, useId, useMemo, useRef, useState, useTransition, type FormEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";

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
import {
  Combobox,
  ComboboxContent,
  ComboboxTrigger,
  ComboboxValue,
} from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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

const METRIC_PROVIDER_LABELS: Record<string, string> = {
  vercel: "Vercel Web Analytics",
  compass_activation: "Compass activation",
};

type OptionsState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; options: ExperimentComposerOptions };

export type ExperimentComposerProps = {
  orgSlug: string;
  workspaceSlug: string;
  /** The panel id: `new`, or `new-<assumptionId>` to preset the tested assumption. */
  composerId: string;
};

/**
 * The "New experiment" composer, rendered by PanelShell in the detail-panel
 * slot (`?detail=experiment-new:new`, or `:new-<assumptionId>` from the OST's
 * "Test this assumption" link). It follows the feedback and opportunity
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
  // A link's preset is an explicit choice made just now, so it wins over the
  // assumption saved with an older draft.
  const [assumptionId, setAssumptionId] = useState<string | null>(presetAssumptionId ?? restored?.assumptionId ?? null);
  const [metricIds, setMetricIds] = useState<string[]>(restored?.metricIds ?? []);
  // Set once the experiment exists but some chosen metrics could not be linked:
  // the composer then explains that instead of silently handing off.
  const [created, setCreated] = useState<{ id: string; unlinked: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<"title" | "hypothesis" | "method" | "killCondition" | null>(null);
  const [optionsState, setOptionsState] = useState<OptionsState>({ status: "loading" });
  const [isPending, startTransition] = useTransition();
  const titleRef = useRef<HTMLInputElement>(null);
  const hypothesisRef = useRef<HTMLTextAreaElement>(null);
  const methodRef = useRef<HTMLTextAreaElement>(null);
  const killConditionRef = useRef<HTMLTextAreaElement>(null);
  const ids = useId();

  // Opening another assumption's "Test this assumption" while the composer is
  // already open changes only the preset; keep everything typed so far.
  const [appliedPreset, setAppliedPreset] = useState(presetAssumptionId);
  if (presetAssumptionId !== appliedPreset) {
    setAppliedPreset(presetAssumptionId);
    if (presetAssumptionId) setAssumptionId(presetAssumptionId);
  }

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
        // A restored draft or a stale link can point at a squad or assumption
        // deleted since. Drop those rather than failing the submit on them.
        setSquadId((id) => (id && options.squads.some((squad) => squad.id === id) ? id : null));
        setAssumptionId((id) => (id && options.assumptions.some((a) => a.id === id) ? id : null));
        setMetricIds((ids) => ids.filter((id) => options.metrics.some((metric) => metric.id === id)));
      })
      .catch(() => {
        if (!cancelled) setOptionsState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [orgSlug, workspaceSlug]);

  const draft: ExperimentDraft = { title, hypothesis, method, killCondition, squadId, assumptionId, metricIds };
  const draftEmpty = isExperimentDraftEmpty(draft);

  useEffect(() => {
    saveExperimentDraft(draftKey, { title, hypothesis, method, killCondition, squadId, assumptionId, metricIds });
  }, [draftKey, title, hypothesis, method, killCondition, squadId, assumptionId, metricIds]);

  useFocusOnOpen(titleRef);

  const options = optionsState.status === "ready" ? optionsState.options : null;

  const resetFields = () => {
    setTitle("");
    setHypothesis("");
    setMethod("");
    setKillCondition("");
    setSquadId(null);
    setAssumptionId(null);
    setMetricIds([]);
  };

  const discardDraft = () => {
    // Empty the fields too, not just storage: until the panel closes the
    // persist effect would re-save whatever is still in state.
    resetFields();
    clearExperimentDraft(draftKey);
    closePanel();
  };

  const clearInvalid = (field: NonNullable<typeof invalid>, value: string) => {
    if (invalid === field && value.trim()) {
      setInvalid(null);
      setError(null);
    }
  };

  const submit = () => {
    if (isPending) return;
    const missing: { field: NonNullable<typeof invalid>; message: string; ref: { current: HTMLElement | null } }[] = [
      { field: "title", message: "Add a title so your team can scan this at a glance.", ref: titleRef },
      { field: "hypothesis", message: "Add a hypothesis: what do you believe is true?", ref: hypothesisRef },
      { field: "method", message: "Add a method: how will you test it?", ref: methodRef },
      { field: "killCondition", message: "Add a kill condition: when will you stop?", ref: killConditionRef },
    ];
    const values = { title, hypothesis, method, killCondition };
    const first = missing.find((entry) => !values[entry.field].trim());
    if (first) {
      setInvalid(first.field);
      setError(first.message);
      first.ref.current?.focus();
      return;
    }
    setError(null);
    setInvalid(null);

    startTransition(async () => {
      try {
        const result = await createExperimentFromComposer(orgSlug, workspaceSlug, {
          title,
          hypothesis,
          method,
          killCondition,
          squadId,
          assumptionId,
          metricIds,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        clearExperimentDraft(draftKey);
        resetFields();
        router.refresh();
        if (result.unlinkedMetrics.length > 0) {
          setCreated({ id: result.experiment.id, unlinked: result.unlinkedMetrics });
          return;
        }
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

  if (created) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4 px-5 pt-4 pb-5" data-slot="experiment-composer-created">
        <p role="status" className="text-sm font-medium text-text-primary">
          Experiment created.
        </p>
        <p role="alert" className="text-sm text-text-secondary">
          {created.unlinked.length === 1 ? "This metric" : "These metrics"} couldn&apos;t be linked:{" "}
          {created.unlinked.join(", ")}. You can link {created.unlinked.length === 1 ? "it" : "them"} from the
          experiment&apos;s Measurements.
        </p>
        <div>
          <Button type="button" onClick={() => openPanel("experiment", created.id, { replace: true })}>
            Open experiment
          </Button>
        </div>
      </div>
    );
  }

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
            clearInvalid("title", value);
          }}
          maxLength={EXPERIMENT_TITLE_MAX_LENGTH}
          placeholder="What are you testing?"
          invalid={invalid === "title"}
          errorId={`${ids}-error`}
          disabled={isPending}
        />

        {options && options.assumptions.length > 0 && (
          <AssumptionField
            id={`${ids}-assumption`}
            assumptions={options.assumptions}
            value={assumptionId}
            onChange={setAssumptionId}
            disabled={isPending}
          />
        )}

        <TextField
          id={`${ids}-hypothesis`}
          label="Hypothesis"
          inputRef={hypothesisRef}
          value={hypothesis}
          onChange={(value) => {
            setHypothesis(value);
            clearInvalid("hypothesis", value);
          }}
          placeholder="We believe that..."
          rows={3}
          invalid={invalid === "hypothesis"}
          errorId={`${ids}-error`}
          disabled={isPending}
        />

        <TextField
          id={`${ids}-method`}
          label="Method"
          inputRef={methodRef}
          value={method}
          onChange={(value) => {
            setMethod(value);
            clearInvalid("method", value);
          }}
          placeholder="We will test this by..."
          rows={3}
          invalid={invalid === "method"}
          errorId={`${ids}-error`}
          disabled={isPending}
        />

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${ids}-kill`} className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
            <span aria-hidden="true" className="text-amber-500">
              &#9888;
            </span>
            Kill Condition
          </label>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-1 dark:border-amber-800 dark:bg-amber-950/20">
            <Textarea
              ref={killConditionRef}
              id={`${ids}-kill`}
              name="killCondition"
              value={killCondition}
              onChange={(event) => {
                setKillCondition(event.target.value);
                clearInvalid("killCondition", event.target.value);
              }}
              placeholder="We will kill this experiment if..."
              rows={2}
              disabled={isPending}
              aria-invalid={invalid === "killCondition" || undefined}
              aria-describedby={invalid === "killCondition" ? `${ids}-error` : undefined}
              className="border-0 bg-transparent ring-0 focus-visible:ring-0"
            />
          </div>
          <p className="text-xs text-text-subtle">
            Define the hard gate before you start. This will be shown prominently during the experiment.
          </p>
        </div>

        {options && options.squads.length > 0 && (
          <SquadField
            id={`${ids}-squad`}
            squads={options.squads}
            value={squadId}
            onChange={setSquadId}
            disabled={isPending}
          />
        )}

        {options && (
          <MetricsField
            id={`${ids}-metrics`}
            metrics={options.metrics}
            selected={metricIds}
            onChange={setMetricIds}
            disabled={isPending}
            metricsHref={`/${orgSlug}/${workspaceSlug}/metrics`}
          />
        )}

        {optionsState.status === "loading" && (
          <p className="text-xs text-text-subtle" aria-busy="true">
            Loading assumptions and squads…
          </p>
        )}
        {optionsState.status === "error" && (
          <p className="text-xs text-text-subtle">
            Couldn&apos;t load assumptions and squads. You can still create the experiment.
          </p>
        )}
      </div>

      <ComposerFooter
        error={error}
        errorId={`${ids}-error`}
        isPending={isPending}
        draftEmpty={draftEmpty}
        onClose={closePanel}
        discardDescription="Your title, hypothesis, method and kill condition will be deleted. Closing the panel instead keeps the draft."
        onDiscard={discardDraft}
        submitDisabled={isPending}
      />
    </form>
  );
}

function TextField({
  id,
  label,
  inputRef,
  value,
  onChange,
  placeholder,
  rows,
  invalid,
  errorId,
  disabled,
}: {
  id: string;
  label: string;
  inputRef: React.Ref<HTMLTextAreaElement>;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  rows: number;
  invalid: boolean;
  errorId: string;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-text-secondary">
        {label}
      </label>
      <Textarea
        ref={inputRef}
        id={id}
        name={label.toLowerCase()}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
      />
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
      <span id={id} className="text-xs font-medium text-text-secondary">
        Testing assumption <span className="font-normal text-text-subtle">· optional</span>
      </span>
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
        Linking an assumption lets concluding this experiment automatically update the assumption&apos;s
        validated/invalidated status.
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
      <span id={id} className="text-xs font-medium text-text-secondary">
        Squad <span className="font-normal text-text-subtle">· optional</span>
      </span>
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

function MetricsField({
  id,
  metrics,
  selected,
  onChange,
  disabled,
  metricsHref,
}: {
  id: string;
  metrics: ExperimentComposerOptions["metrics"];
  selected: string[];
  onChange: (value: string[]) => void;
  disabled: boolean;
  metricsHref: string;
}) {
  const toggle = (metricId: string, on: boolean) =>
    onChange(on ? [...selected, metricId] : selected.filter((existing) => existing !== metricId));
  return (
    <div className="flex flex-col gap-1.5">
      <span id={id} className="text-xs font-medium text-text-secondary">
        Metrics <span className="font-normal text-text-subtle">· optional</span>
      </span>
      {metrics.length > 0 ? (
        <div
          role="group"
          aria-labelledby={id}
          className="flex max-h-44 flex-col gap-0.5 overflow-y-auto rounded-lg border border-border p-1"
        >
          {metrics.map((metric) => (
            <label
              key={metric.id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
            >
              <Checkbox
                checked={selected.includes(metric.id)}
                onCheckedChange={(checked) => toggle(metric.id, checked === true)}
                disabled={disabled}
              />
              <span className="min-w-0 flex-1 truncate">{metric.name}</span>
              <span className="shrink-0 text-xs text-text-subtle">
                {metric.unit} · {METRIC_PROVIDER_LABELS[metric.provider] ?? metric.provider}
              </span>
            </label>
          ))}
        </div>
      ) : (
        <p className="text-xs text-text-subtle">No metrics are defined in this workspace yet.</p>
      )}
      <p className="text-xs text-text-subtle">
        Chosen metrics are tracked over the last 30 days. Add comparison periods from the experiment afterwards.{" "}
        <a href={metricsHref} target="_blank" rel="noreferrer" className="underline underline-offset-2">
          {metrics.length > 0 ? "Manage metrics" : "Create a metric"}
        </a>
      </p>
    </div>
  );
}
