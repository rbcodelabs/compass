"use client"

/**
 * The factor picker.
 *
 * The options come from `listCardSortFactors`, which returns every SELECT custom
 * field on the object type with its effective options already resolved — so a
 * field backed by a shared option set and one with local options arrive in the
 * same shape and this component cannot tell them apart. That is the point: there
 * is nothing here to special-case, which is what makes Priority, Vertical and
 * Quarter work without a code change.
 */

import { useLabels } from "@/components/thinking-model/thinking-model-provider"
import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export type FactorOption = {
  id: string
  name: string
  options: { value: string; label: string }[]
  sharedOptionSetName: string | null
}

export function NewRoundForm({
  orgSlug,
  workspaceSlug,
  factors,
  objectLabel,
}: {
  orgSlug: string
  workspaceSlug: string
  factors: FactorOption[]
  /** Lowercase plural name of the object type being sorted, for the empty state. */
  objectLabel?: string
}) {
  const router = useRouter()
  const labels = useLabels()
  const [fieldDefinitionId, setFieldDefinitionId] = useState(factors[0]?.id ?? "")
  const [name, setName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [, startTransition] = useTransition()

  const selected = factors.find((factor) => factor.id === fieldDefinitionId)

  if (factors.length === 0) {
    return (
      <p className="text-sm text-text-secondary">
        {`This workspace has no SELECT custom fields on ${objectLabel ?? labels.opportunity.lowerPlural}, so there is nothing to sort by.`}
        {" "}A factor is a SELECT field &mdash; its options become the buckets.
      </p>
    )
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(
        `/api/card-sort/rounds?orgSlug=${encodeURIComponent(orgSlug)}&workspaceSlug=${encodeURIComponent(workspaceSlug)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim() || `${selected?.name} sort`,
            fieldDefinitionId,
          }),
        }
      )
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string
        round?: { id: string }
      }
      if (!response.ok || !payload.round) {
        setError(payload.error ?? `Could not create the round (${response.status})`)
        return
      }
      startTransition(() =>
        router.push(`/${orgSlug}/${workspaceSlug}/card-sort/${payload.round!.id}`)
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-md bg-surface-panel p-3 ring-1 ring-border-default">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="card-sort-factor">Factor to judge</Label>
          <select
            id="card-sort-factor"
            value={fieldDefinitionId}
            onChange={(event) => setFieldDefinitionId(event.target.value)}
            className="h-8 rounded-lg border border-border-default bg-background px-2 text-sm"
          >
            {factors.map((factor) => (
              <option key={factor.id} value={factor.id}>
                {factor.name} ({factor.options.length} buckets)
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="card-sort-name">Round name</Label>
          <Input
            id="card-sort-name"
            value={name}
            placeholder={selected ? `${selected.name} sort` : "Round name"}
            onChange={(event) => setName(event.target.value)}
            className="w-64"
          />
        </div>
        <Button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Start round"}
        </Button>
      </div>

      {selected && (
        <p className="text-xs text-text-secondary">
          Buckets from{" "}
          {selected.sharedOptionSetName
            ? `the shared option set “${selected.sharedOptionSetName}”`
            : "this field’s own options"}
          : {selected.options.map((option) => option.label).join(" · ")}
        </p>
      )}

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  )
}
