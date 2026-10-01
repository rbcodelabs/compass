import type { ReactNode } from "react"
import { Input } from "@/components/ui/input"
import { FormField } from "@/components/patterns/form-field"
import { cn } from "@/lib/utils"

/** Small controlled-field helpers for the widget config forms. */

export function TextField({
  id, label, value, onChange, max, description, placeholder, required,
}: { id: string; label: string; value: string; onChange: (value: string) => void; max: number; description?: ReactNode; placeholder?: string; required?: boolean }) {
  return (
    <FormField id={id} label={label} description={description} required={required}>
      <Input id={id} value={value} maxLength={max} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </FormField>
  )
}

export function TextAreaField({
  id, label, value, onChange, max, rows = 4, description,
}: { id: string; label: string; value: string; onChange: (value: string) => void; max: number; rows?: number; description?: ReactNode }) {
  return (
    <FormField id={id} label={label} description={description}>
      <textarea
        id={id}
        value={value}
        rows={rows}
        maxLength={max}
        onChange={(event) => onChange(event.target.value)}
        className="w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
      />
    </FormField>
  )
}

export function SelectField({
  id, label, value, onChange, options, className,
}: { id: string; label: string; value: string; onChange: (value: string) => void; options: { value: string; label: string }[]; className?: string }) {
  return (
    <FormField id={id} label={label}>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn("h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30", className)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </FormField>
  )
}

export function CheckboxField({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm text-text-primary">
      <input id={id} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="size-4 accent-[var(--color-primary)]" />
      {label}
    </label>
  )
}
