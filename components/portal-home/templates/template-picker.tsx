"use client"

import { useId } from "react"
import { PORTAL_TEMPLATES, PORTAL_TEMPLATE_META, type PortalTemplate } from "@/lib/portal-home/templates"
import { cn } from "@/lib/utils"

interface Props {
  value: PortalTemplate
  onChange: (template: PortalTemplate) => void
  disabled?: boolean
}

const BAR = "rounded-[2px] bg-text-disabled/60"
const CARD = "rounded-[2px] bg-text-subtle/35"

/** Tiny CSS thumbnails (decorative): the layout of each template at a glance. */
function Thumbnail({ template }: { template: PortalTemplate }) {
  if (template === "editorial") {
    return (
      <div className="flex h-full flex-col items-center gap-1 p-1.5">
        <div className={cn(BAR, "mt-0.5 h-1 w-8")} />
        <div className={cn(BAR, "h-2 w-12 bg-text-primary/70")} />
        <div className={cn(CARD, "mt-1 h-2.5 w-14")} />
        <div className={cn(CARD, "h-2.5 w-14")} />
      </div>
    )
  }
  if (template === "bento") {
    return (
      <div className="flex h-full flex-col">
        <div className="h-5 bg-primary/80" />
        <div className="-mt-2 grid grid-cols-3 gap-1 px-1.5">
          <div className="col-span-2 h-3 rounded-[2px] bg-surface-panel ring-1 ring-border-strong" />
          <div className="h-3 rounded-[2px] bg-surface-panel ring-1 ring-border-strong" />
          <div className="h-3 rounded-[2px] bg-surface-panel ring-1 ring-border-strong" />
          <div className="col-span-2 h-3 rounded-[2px] bg-surface-panel ring-1 ring-border-strong" />
        </div>
      </div>
    )
  }
  if (template === "shell") {
    return (
      <div className="flex h-full">
        <div className="flex w-5 flex-col gap-1 border-r border-border-default bg-surface-interactive p-1">
          <div className="h-1 rounded-[1px] bg-primary/70" />
          <div className="h-1 rounded-[1px] bg-text-disabled/60" />
          <div className="h-1 rounded-[1px] bg-text-disabled/60" />
        </div>
        <div className="grid flex-1 grid-cols-2 content-start gap-1 p-1.5">
          <div className={cn(CARD, "col-span-2 h-3")} />
          <div className={cn(CARD, "h-4")} />
          <div className={cn(CARD, "h-4")} />
        </div>
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-5 items-center justify-center bg-[#14110F]">
        <div className="h-1.5 w-12 rounded-full bg-white/90" />
      </div>
      <div className="grid grid-cols-[1fr_0.5fr] gap-1 p-1.5">
        <div className="flex flex-col gap-1">
          <div className="grid grid-cols-3 gap-0.5">
            <div className={cn(CARD, "h-3")} />
            <div className={cn(CARD, "h-3")} />
            <div className={cn(CARD, "h-3")} />
          </div>
          <div className={cn(CARD, "h-2")} />
        </div>
        <div className={cn(CARD, "h-5")} />
      </div>
    </div>
  )
}

/** Four radio cards: choose how the home is laid out. Saved with the draft and published with it. */
export function TemplatePicker({ value, onChange, disabled }: Props) {
  const name = useId()
  return (
    <fieldset className="flex flex-col gap-2" data-testid="portal-template-picker" disabled={disabled}>
      <legend className="mb-1 text-sm font-medium text-text-primary">Template</legend>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {PORTAL_TEMPLATES.map((template) => {
          const meta = PORTAL_TEMPLATE_META[template]
          const checked = value === template
          return (
            <label
              key={template}
              className={cn(
                "relative flex cursor-pointer flex-col gap-2 rounded-xl border bg-surface-panel p-2.5 text-left hover:bg-surface-inset has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
                checked ? "border-primary ring-2 ring-primary" : "border-border-default",
              )}
            >
              <input type="radio" name={name} value={template} checked={checked} onChange={() => onChange(template)} className="sr-only" />
              <span aria-hidden className="block h-16 overflow-hidden rounded-md border border-border-default bg-surface-app">
                <Thumbnail template={template} />
              </span>
              <span className="text-sm font-semibold text-text-primary">{meta.label}</span>
              <span className="text-xs leading-4 text-text-subtle">{meta.description}</span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
