"use client"

import { OKR_SUMMARY_MAX_OBJECTIVES, type OkrSummaryConfig } from "@/lib/portal-home/widgets/okr-summary"
import type { OkrObjectiveItem, ResolvedWidgetData } from "@/lib/portal-home/data"
import { StatusBadge } from "@/components/patterns/status-badge"
import { MoreLink, WidgetCard } from "../widget-frame"
import { SelectField, TextField } from "../form-controls"
import { OrderedPicker } from "../ordered-picker"
import type { ConfigFormProps, RendererProps } from "../types"
import { useLabels } from "@/components/thinking-model/thinking-model-provider"

type OkrData = Extract<ResolvedWidgetData, { type: "okr_summary" }>

const STATUS: Record<string, { label: string; tone: "success" | "warning" | "danger" | "info" | "neutral" }> = {
  ON_TRACK: { label: "On track", tone: "success" },
  AT_RISK: { label: "At risk", tone: "warning" },
  OFF_TRACK: { label: "Off track", tone: "danger" },
  COMPLETE: { label: "Complete", tone: "info" },
}

function ObjectiveRow({ objective, showCycle }: { objective: OkrObjectiveItem; showCycle: boolean }) {
  const labels = useLabels()
  const status = STATUS[objective.status] ?? { label: objective.status, tone: "neutral" as const }
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-text-primary">{objective.title}</span>
        <StatusBadge status={status.tone}>{status.label}</StatusBadge>
      </div>
      <div className="flex items-center gap-2">
        <div
          role="progressbar"
          aria-label={`${objective.title} progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={objective.progress}
          className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-inset"
        >
          <div className="h-full rounded-full bg-primary" style={{ width: `${objective.progress}%` }} />
        </div>
        <span className="w-9 text-right text-xs text-text-subtle tabular-nums">{objective.progress}%</span>
      </div>
      <span className="text-xs text-text-subtle">
        {objective.keyResultCount} {objective.keyResultCount === 1 ? labels.keyResult.lower : labels.keyResult.lowerPlural}
        {showCycle && objective.cycleTitle ? ` · ${objective.cycleTitle}` : ""}
      </span>
    </li>
  )
}

/** Team-only OKR progress: each objective's key results averaged into one bar. */
export function OkrSummaryRenderer({ config, data }: RendererProps<OkrSummaryConfig, OkrData>) {
  const labels = useLabels()
  return (
    <WidgetCard title={config.title}>
      {data.cycleTitle ? <p className="-mt-1 text-xs text-text-subtle">{data.cycleTitle}</p> : null}
      <ul className="flex flex-col gap-4" data-testid="okr-summary-list">
        {data.objectives.map((objective) => (
          <ObjectiveRow key={objective.id} objective={objective} showCycle={config.mode === "selected"} />
        ))}
      </ul>
      <MoreLink href={data.okrsHref}>View all {labels.sections.okrs}</MoreLink>
    </WidgetCard>
  )
}

export function OkrSummaryForm({ config, onChange, options }: ConfigFormProps<OkrSummaryConfig>) {
  const labels = useLabels()
  const cycles = options?.okrCycles ?? []
  const savedCycle = config.cycleId
  const omittedCycle = savedCycle && !cycles.some((cycle) => cycle.id === savedCycle) ? savedCycle : null
  const objectives = (options?.objectives ?? []).map((objective) => ({ id: objective.id, label: objective.title, hint: objective.cycleTitle ?? `No ${labels.cycle.lower}` }))
  return (
    <div className="flex flex-col gap-3">
      <TextField id="okr-title" label="Title" value={config.title} max={80} required onChange={(title) => onChange({ ...config, title })} />
      <SelectField
        id="okr-mode"
        label={`Which ${labels.objective.lowerPlural}`}
        value={config.mode}
        onChange={(mode) => onChange({ ...config, mode: mode as OkrSummaryConfig["mode"] })}
        options={[
          { value: "active", label: `Active ${labels.cycle.lower}` },
          { value: "cycle", label: `A specific ${labels.cycle.lower}` },
          { value: "selected", label: `Selected ${labels.objective.lowerPlural}` },
        ]}
      />
      <SelectField
        id="okr-max"
        label={`Maximum ${labels.objective.lowerPlural} shown`}
        value={String(config.maxObjectives)}
        onChange={(maxObjectives) => onChange({ ...config, maxObjectives: Number(maxObjectives) })}
        options={Array.from({ length: OKR_SUMMARY_MAX_OBJECTIVES }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
      />
      {config.mode === "cycle" ? (
        cycles.length > 0 || omittedCycle ? (
          <SelectField
            id="okr-cycle"
            label={labels.cycle.singular}
            value={config.cycleId ?? ""}
            onChange={(cycleId) => onChange({ ...config, cycleId: cycleId || null })}
            options={[{ value: "", label: `Choose a ${labels.cycle.lower}…` }, ...(omittedCycle ? [{ value: omittedCycle, label: `Selected ${labels.cycle.lower} outside this list` }] : []), ...cycles.map((cycle) => ({ value: cycle.id, label: cycle.title }))]}
          />
        ) : !options?.unavailable ? (
          <p className="text-xs leading-5 text-text-subtle">{options === null ? `Loading ${labels.cycle.lowerPlural}…` : `No ${labels.sections.okr} ${labels.cycle.lowerPlural} yet.`}</p>
        ) : null
      ) : null}
      {config.mode === "selected" ? (
        <OrderedPicker
          idPrefix="okr"
          heading={`Choose ${labels.objective.lowerPlural}`}
          noun={labels.objective.lower}
          items={objectives}
          selectedIds={config.objectiveIds}
          max={OKR_SUMMARY_MAX_OBJECTIVES}
          loading={options === null}
          unavailable={options?.unavailable}
          onChange={(objectiveIds) => onChange({ ...config, objectiveIds })}
        />
      ) : null}
      {config.mode === "active" ? <p className="text-xs leading-5 text-text-subtle">Shows {labels.objective.lowerPlural} from the newest active {labels.cycle.lower}, or {labels.objective.lowerPlural} without a {labels.cycle.lower} if none is active.</p> : null}
    </div>
  )
}
