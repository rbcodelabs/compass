import { ArrowDown, ArrowUp, X } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"

export interface PickerItem {
  id: string
  label: string
  /** Muted text after the label (a cycle name, a type). */
  hint?: string
}

/**
 * Pick up to `max` items from a list and order them: a reorderable "selected" list above a checkbox list of
 * everything available. Shared by the artifact gallery and OKR widget forms. Ids that are no longer in `items`
 * (archived or deleted) stay listed as "Unavailable" so the admin can remove them.
 */
export function OrderedPicker({
  idPrefix, heading, noun, items, selectedIds, max, loading, unavailable, onChange,
}: {
  idPrefix: string
  heading: string
  noun: string
  items: PickerItem[]
  selectedIds: string[]
  max: number
  loading: boolean
  unavailable?: boolean
  onChange: (ids: string[]) => void
}) {
  const byId = new Map(items.map((item) => [item.id, item]))
  const atLimit = selectedIds.length >= max
  const toggle = (id: string, on: boolean) => onChange(on ? [...selectedIds, id] : selectedIds.filter((x) => x !== id))
  const move = (index: number, delta: -1 | 1) => {
    const next = [...selectedIds]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">{heading}</span>
      {loading ? <p className="text-xs text-text-subtle">Loading {noun}s…</p> : null}
      {!loading && !unavailable && items.length === 0 ? <p className="text-xs leading-5 text-text-subtle">No {noun}s yet.</p> : null}
      {selectedIds.length > 0 ? (
        <ol className="flex flex-col gap-1" aria-label={`Selected ${noun}s, in display order`}>
          {selectedIds.map((id, index) => {
            const item = byId.get(id)
            const name = item ? item.label || "Untitled" : `Selected ${noun} outside this list`
            return (
              <li key={id} className="flex items-center gap-1.5 rounded-md border border-border-default bg-surface-inset px-2 py-1 text-xs">
                <span className="min-w-0 flex-1 truncate">{name}</span>
                <button type="button" aria-label={`Move ${name} up`} disabled={index === 0} className="rounded p-0.5 hover:bg-muted disabled:opacity-40" onClick={() => move(index, -1)}>
                  <ArrowUp className="size-3" />
                </button>
                <button type="button" aria-label={`Move ${name} down`} disabled={index === selectedIds.length - 1} className="rounded p-0.5 hover:bg-muted disabled:opacity-40" onClick={() => move(index, 1)}>
                  <ArrowDown className="size-3" />
                </button>
                <button type="button" aria-label={`Remove ${name}`} className="rounded p-0.5 hover:bg-muted" onClick={() => toggle(id, false)}>
                  <X className="size-3" />
                </button>
              </li>
            )
          })}
        </ol>
      ) : null}
      {items.length > 0 ? (
        <ul className="max-h-56 overflow-y-auto rounded-md border border-border-default" aria-label={`Available ${noun}s`}>
          {items.map((item) => {
            const checked = selectedIds.includes(item.id)
            const id = `${idPrefix}-pick-${item.id}`
            return (
              <li key={item.id} className="border-b border-border-default last:border-b-0">
                <label htmlFor={id} className="flex items-center gap-2 px-2.5 py-1.5 text-sm">
                  <Checkbox id={id} checked={checked} disabled={!checked && atLimit} onCheckedChange={(next) => toggle(item.id, next === true)} />
                  <span className="min-w-0 flex-1 truncate">{item.label || "Untitled"}</span>
                  {item.hint ? <span className="shrink-0 text-xs text-text-subtle">{item.hint}</span> : null}
                </label>
              </li>
            )
          })}
        </ul>
      ) : null}
      <p className="text-xs leading-5 text-text-subtle">Up to {max} {noun}s. Use the arrows to set the order.</p>
    </div>
  )
}
