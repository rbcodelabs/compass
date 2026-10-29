"use client";

import { useId, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type CatalogPickerOption = { value: string; label: string; provider?: string };

const CURATED_GROUP = "Recommended";
const selectClass = "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30";

/** Searches name, id and provider; empty query matches everything. */
export function matchesModelQuery(option: CatalogPickerOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [option.label, option.value, option.provider ?? ""].some((text) => text.toLowerCase().includes(q));
}

/**
 * Searchable model picker for the AI Gateway catalog (a few hundred entries): a text search, a provider filter, and a
 * scrollable list grouped by provider. The curated entries (no provider) are grouped first as "Recommended". "System
 * default" stays the first row. A stored value that is not in the list is still shown, so editing never silently drops it.
 */
export function ModelCatalogPicker({ value, onChange, options, disabled, labelId }: { value: string; onChange: (next: string) => void; options: CatalogPickerOption[]; disabled?: boolean; labelId: string }) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("");
  const providers = useMemo(() => [...new Set(options.flatMap((o) => (o.provider ? [o.provider] : [])))].sort(), [options]);
  const groups = useMemo(() => {
    const visible = options.filter((o) => (!provider || (o.provider ?? CURATED_GROUP) === provider) && matchesModelQuery(o, query));
    const byGroup = new Map<string, CatalogPickerOption[]>();
    for (const option of visible) {
      const key = option.provider ?? CURATED_GROUP;
      byGroup.set(key, [...(byGroup.get(key) ?? []), option]);
    }
    return [...byGroup.entries()].sort(([a], [b]) => (a === CURATED_GROUP ? -1 : b === CURATED_GROUP ? 1 : a.localeCompare(b)));
  }, [options, provider, query]);
  const selected = options.find((o) => o.value === value);
  const selectedText = !value ? "System default" : selected ? `${selected.label} (${selected.value})` : `${value} (no longer offered)`;
  const row = (active: boolean) => cn("flex w-full min-w-0 flex-col rounded-md px-2 py-1.5 text-left text-sm hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:flex-row sm:items-baseline sm:gap-2", active && "bg-bg-subtle font-medium");
  return <div role="group" aria-labelledby={labelId} className="min-w-0 space-y-2">
    <p className="break-words text-xs text-text-muted" data-testid="model-selected">Selected: {selectedText}</p>
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
      <Input aria-label="Search models" type="search" placeholder="Search by name, id or provider" value={query} onChange={(e) => setQuery(e.target.value)} disabled={disabled} className="sm:flex-1" />
      <select aria-label="Filter by provider" className={cn(selectClass, "sm:w-44")} value={provider} onChange={(e) => setProvider(e.target.value)} disabled={disabled}>
        <option value="">All providers</option>
        {options.some((o) => !o.provider) && <option value={CURATED_GROUP}>{CURATED_GROUP}</option>}
        {providers.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>
    </div>
    <div role="listbox" id={`${id}-list`} aria-label="Models" className="max-h-60 min-w-0 overflow-y-auto rounded-lg border border-border-default p-1">
      <button type="button" role="option" aria-selected={!value} className={row(!value)} onClick={() => onChange("")} disabled={disabled}>System default</button>
      {groups.map(([group, items]) => <div key={group} role="group" aria-label={group}>
        <p className="sticky top-0 bg-bg-surface px-2 pt-2 pb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">{group}</p>
        {items.map((o) => <button key={o.value} type="button" role="option" aria-selected={o.value === value} className={row(o.value === value)} onClick={() => onChange(o.value)} disabled={disabled}>
          <span className="min-w-0 break-words">{o.label}</span>
          <span className="min-w-0 break-all text-xs text-text-muted">{o.value}</span>
        </button>)}
      </div>)}
      {groups.length === 0 && <p className="px-2 py-3 text-sm text-text-muted">No models match.</p>}
    </div>
  </div>;
}
