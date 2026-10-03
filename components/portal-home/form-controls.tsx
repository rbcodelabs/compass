import type { ReactNode } from "react"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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
      <Textarea id={id} value={value} rows={rows} maxLength={max} onChange={(event) => onChange(event.target.value)} />
    </FormField>
  )
}

export function SelectField({
  id, label, value, onChange, options, className,
}: { id: string; label: string; value: string; onChange: (value: string) => void; options: { value: string; label: string }[]; className?: string }) {
  return (
    <FormField id={id} label={label}>
      <Select value={value} onValueChange={(next) => next !== null && onChange(String(next))}>
        <SelectTrigger id={id} className={cn("w-full", className)}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormField>
  )
}

export function CheckboxField({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm text-text-primary">
      <Checkbox id={id} checked={checked} onCheckedChange={(next) => onChange(next === true)} />
      {label}
    </label>
  )
}
