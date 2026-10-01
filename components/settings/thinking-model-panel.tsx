"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
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
import { MAX_LABEL_LENGTH, validateLabelOverrides, type LabelOverrides } from "@/lib/thinking-model/validate"

// Describe only what ships: the presets differ in names today, nothing else.
const PRESET_DESCRIPTIONS: Record<ThinkingModelKey, string> = {
  CLASSIC: "Objectives and Key Results, as Compass has always named them.",
  OPPORTUNITY_FIRST_OKR: "Same names as Classic.",
  TORRES_OST: "Renames Objective to Outcome and Key Result to Success metric.",
}

const ENTITY_TITLES: Record<OverridableEntity, string> = {
  objective: "Objective",
  keyResult: "Key Result",
}

type FormLabels = Record<OverridableEntity, { singular: string; plural: string }>

interface Props {
  orgSlug: string
  workspaceSlug: string
  initialKey: ThinkingModelKey
  initialOverrides: LabelOverrides
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

export function ThinkingModelPanel({ orgSlug, workspaceSlug, initialKey, initialOverrides }: Props) {
  const [key, setKey] = useState<ThinkingModelKey>(initialKey)
  const [form, setForm] = useState<FormLabels>(() => toForm(initialOverrides))
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null)
  const [isPending, startTransition] = useTransition()
  const preset = THINKING_MODEL_PRESETS[key]
  // A preset that is no longer offered (OPPORTUNITY_FIRST_OKR until its picker
  // exists) still shows when it is the stored one, so the form never silently
  // un-selects the current model.
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
        Some screens still use the standard names whatever you choose here: the canvas, the discovery board and its
        panels, the public portal, and help. Agents and API tools always use the standard names.
      </p>

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
        <Button type="button" onClick={save} disabled={isPending} data-testid="thinking-model-save">
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
