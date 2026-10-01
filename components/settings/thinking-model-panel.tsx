"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { updateThinkingModel } from "@/app/[orgSlug]/[workspaceSlug]/settings/thinking-model-actions"
import {
  OVERRIDABLE_ENTITIES,
  PICKABLE_THINKING_MODEL_KEYS,
  THINKING_MODEL_PRESETS,
  type OverridableEntity,
  type ThinkingModelKey,
} from "@/lib/thinking-model/presets"
import { remainingCanonicalNotice } from "@/lib/thinking-model/canonical-surfaces"
import { MAX_LABEL_LENGTH, validateLabelOverrides, type LabelOverrides } from "@/lib/thinking-model/validate"

// Describe only what ships: names, plus the workspace tree and the opportunity-to-objective picker for the two non-classic models.
const PRESET_DESCRIPTIONS: Record<ThinkingModelKey, string> = {
  CLASSIC: "Objectives and Key Results, as Compass has always named them.",
  OPPORTUNITY_FIRST_OKR: "Same names as Classic. Adds a tree that starts from a pool of opportunities and runs through objectives and key results to solutions, and lets you link an opportunity to the objectives you chose to pursue.",
  TORRES_OST: "Renames Objective to Outcome and Key Result to Success metric. Adds an outcome tree under Discovery, a flat list of all outcomes on the Outcomes page, and lets you link an opportunity to several outcomes. New outcomes still belong to a cycle for now.",
}

const ENTITY_TITLES: Record<OverridableEntity, string> = {
  opportunity: "Opportunity",
  objective: "Objective",
  keyResult: "Key Result",
  solution: "Solution",
  cycle: "Cycle",
}

type FormLabels = Record<OverridableEntity, { singular: string; plural: string }>

interface Props {
  orgSlug: string
  workspaceSlug: string
  initialKey: ThinkingModelKey
  initialOverrides: LabelOverrides
  /**
   * Raw stored label text that is NOT in effect (it no longer passes validation,
   * or sits beside an unknown preset). Shown so saving cannot silently wipe it.
   */
  unappliedStored?: string | null
}

function toForm(overrides: LabelOverrides): FormLabels {
  return Object.fromEntries(
    OVERRIDABLE_ENTITIES.map((e) => [e, { singular: overrides[e]?.singular ?? "", plural: overrides[e]?.plural ?? "" }]),
  ) as FormLabels
}

function fromForm(form: FormLabels): LabelOverrides {
  const out: LabelOverrides = {}
  for (const entity of OVERRIDABLE_ENTITIES) {
    const { singular, plural } = form[entity]
    // An empty singular means "use the preset's name"; a plural alone is kept so
    // validation can say it needs a singular.
    if (singular.trim() === "" && plural.trim() === "") continue
    out[entity] = plural.trim() === "" ? { singular } : { singular, plural }
  }
  return out
}

export function ThinkingModelPanel({ orgSlug, workspaceSlug, initialKey, initialOverrides, unappliedStored = null }: Props) {
  const [key, setKey] = useState<ThinkingModelKey>(initialKey)
  const [replaceStored, setReplaceStored] = useState(false)
  const [form, setForm] = useState<FormLabels>(() => toForm(initialOverrides))
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null)
  const [isPending, startTransition] = useTransition()
  const preset = THINKING_MODEL_PRESETS[key]
  // A stored preset that is not in the offered list (none today) still shows, so
  // the form never silently un-selects the current model.
  const offered: ThinkingModelKey[] = [...PICKABLE_THINKING_MODEL_KEYS]
  if (!offered.includes(initialKey)) offered.push(initialKey)

  function setField(entity: OverridableEntity, field: "singular" | "plural", value: string) {
    setMessage(null)
    setForm((current) => ({ ...current, [entity]: { ...current[entity], [field]: value } }))
  }

  function save() {
    const overrides = fromForm(form)
    const checked = validateLabelOverrides(overrides, key)
    if (!checked.ok) {
      setMessage({ tone: "error", text: checked.error })
      return
    }
    startTransition(async () => {
      const result = await updateThinkingModel(orgSlug, workspaceSlug, { thinkingModel: key, labels: checked.value })
      setMessage(result.ok ? { tone: "success", text: "Saved." } : { tone: "error", text: result.error })
    })
  }

  return (
    <div className="flex flex-col gap-5" data-testid="thinking-model-panel">
      <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground" data-testid="thinking-model-notice">
        {remainingCanonicalNotice()}
      </p>

      {unappliedStored !== null && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-lg border border-status-warning bg-status-warning-surface px-3 py-2 text-xs text-status-warning"
          data-testid="thinking-model-unapplied"
        >
          <p>
            Custom names are stored for this workspace but are not being used, because they no longer pass the current
            rules (or sit beside an unrecognised model). The fields below are empty. Saving replaces what is stored.
          </p>
          <code className="break-all rounded bg-background/60 px-2 py-1 text-[11px]">{unappliedStored}</code>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={replaceStored}
              onCheckedChange={(next) => setReplaceStored(next === true)}
              data-testid="thinking-model-replace-stored"
            />
            Replace the stored names when I save
          </label>
        </div>
      )}

      <fieldset className="flex flex-col gap-2" disabled={isPending}>
        <legend className="mb-1 text-sm font-medium">Model</legend>
        {offered.map((presetKey) => (
          <label
            key={presetKey}
            className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-card px-4 py-3 has-[:checked]:border-primary"
          >
            <input
              type="radio"
              name="thinking-model"
              value={presetKey}
              checked={key === presetKey}
              onChange={() => {
                setMessage(null)
                setKey(presetKey)
              }}
              className="mt-1"
              data-testid={`thinking-model-${presetKey}`}
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">{THINKING_MODEL_PRESETS[presetKey].name}</span>
              <span className="text-xs text-muted-foreground">{PRESET_DESCRIPTIONS[presetKey]}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="flex flex-col gap-3" disabled={isPending}>
        <legend className="mb-1 text-sm font-medium">Names</legend>
        <p className="text-xs text-muted-foreground">
          Rename these for this workspace. Leave a field empty to keep the model&apos;s name. If you leave the plural
          empty, an &quot;s&quot; is added, so give a plural when that would be wrong. Letters, numbers, spaces and
          &apos; &amp; / - only, up to {MAX_LABEL_LENGTH} characters.
        </p>
        {OVERRIDABLE_ENTITIES.map((entity) => (
          <div key={entity} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`tm-${entity}-singular`}>{ENTITY_TITLES[entity]} (singular)</Label>
              <Input
                id={`tm-${entity}-singular`}
                value={form[entity].singular}
                maxLength={MAX_LABEL_LENGTH * 2}
                placeholder={preset.labels[entity].singular}
                onChange={(e) => setField(entity, "singular", e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`tm-${entity}-plural`}>{ENTITY_TITLES[entity]} (plural)</Label>
              <Input
                id={`tm-${entity}-plural`}
                value={form[entity].plural}
                maxLength={MAX_LABEL_LENGTH * 2}
                placeholder={preset.labels[entity].plural}
                onChange={(e) => setField(entity, "plural", e.target.value)}
              />
            </div>
          </div>
        ))}
      </fieldset>

      <div className="flex items-center gap-3">
        <Button
          type="button"
          onClick={save}
          disabled={isPending || (unappliedStored !== null && !replaceStored)}
          data-testid="thinking-model-save"
        >
          {isPending ? "Saving…" : "Save"}
        </Button>
        {message && (
          <span
            role={message.tone === "error" ? "alert" : "status"}
            className={message.tone === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
          >
            {message.text}
          </span>
        )}
      </div>
    </div>
  )
}
