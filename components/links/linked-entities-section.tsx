"use client"

import React, { useCallback, useEffect, useRef, useState, useTransition } from "react"
import Link from "next/link"
import { changeEntityLink, readEntityLinks } from "@/app/[orgSlug]/[workspaceSlug]/links/actions"
import type { LinkedEntitiesView } from "@/lib/links/read-models"
import { entityPath } from "@/lib/links/entity-routes"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { StatusBadge } from "@/components/patterns/status-badge"
import { Combobox, ComboboxContent, ComboboxTrigger, ComboboxValue } from "@/components/ui/combobox"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

const statusLabel = (status: string) => status.toLowerCase().replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase())
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

export type LinkedEntitiesTarget = { linkType: string; entityType: string; entityId: string }

/**
 * Shared section for one registry link type on one entity, e.g. an experiment's "Informed by" studies or a
 * study's "Informs" experiments. Every word that names the relationship (heading, noun, direction) comes from
 * the view the server builds out of the registry, so a new link type adds no copy here. Renders nothing when
 * the type does not apply (feature flag off, entity not eligible) and only offers candidates the service
 * would accept.
 */
export function LinkedEntitiesSection({ orgSlug, workspaceSlug, target }: { orgSlug: string; workspaceSlug: string; target: LinkedEntitiesTarget }) {
  const [view, setView] = useState<LinkedEntitiesView | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [searching, setSearching] = useState(false)
  const [pending, startTransition] = useTransition()
  const request = useRef(0)
  const { linkType, entityType, entityId } = target

  const load = useCallback(async (query = "") => {
    const current = ++request.current
    setSearching(true)
    try {
      const result = await readEntityLinks(orgSlug, workspaceSlug, { linkType, entityType, entityId }, query)
      if (current !== request.current) return
      if (result.ok) { setView(result.view); setLoaded(true); setError(null) } else setError("Could not load links. Please retry.")
    } catch {
      if (current === request.current) setError("Could not load links. Please retry.")
    } finally { if (current === request.current) setSearching(false) }
  }, [orgSlug, workspaceSlug, linkType, entityType, entityId])

  useEffect(() => {
    setView(null)
    setLoaded(false)
    void load()
    return () => { request.current++ }
  }, [load])
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => { void load(search) }, 200)
    return () => clearTimeout(timer)
  }, [search, open, load])

  function mutate(otherId: string, operation: "link" | "unlink") {
    setError(null)
    startTransition(async () => {
      try {
        const result = await changeEntityLink(orgSlug, workspaceSlug, { linkType, entityType, entityId, otherId, operation })
        if (!result.ok) { setError(result.error); return }
        setSelected(null)
        setOpen(false)
        setSearch("")
        await load()
      } catch { setError("Could not change the link. Refresh and try again.") }
    })
  }

  // Not applicable here (flag off, entity not eligible): render nothing rather than an empty shell.
  if (loaded && !view && !error) return null

  const noun = view?.otherNoun ?? "item"
  const plural = view?.otherNounPlural ?? "items"
  const heading = view?.label ?? "Links"
  const idBase = `linked-entities-${linkType}-${entityId}`

  return <section aria-label={view ? `${heading} ${plural}` : "Links"} data-link-type={linkType} className="flex max-w-3xl flex-col gap-3 rounded-xl border bg-surface-panel p-4">
    <div>
      <h2 className="text-sm font-semibold">{heading}</h2>
      <p className="text-xs text-muted-foreground">{capitalize(plural)}. Linking never changes either record&apos;s status, settings or results.</p>
    </div>
    {!view && !error && <p role="status" className="text-sm text-muted-foreground">Loading links…</p>}
    {view && <>
      {view.linked.length === 0 ? <p className="text-sm text-muted-foreground">No {plural} linked yet.</p> : <ul className="flex flex-col gap-2">
        {view.linked.map((item) => {
          const path = entityPath(item.type, item.id)
          return <li key={item.id} className="flex min-w-0 items-start justify-between gap-2 rounded-lg border p-3">
            <div className="min-w-0 space-y-1">
              {path ? <Link className="block break-words text-sm font-medium underline underline-offset-2" href={`/${orgSlug}/${workspaceSlug}/${path}`}>{item.title}</Link> : <span className="block break-words text-sm font-medium">{item.title}</span>}
              {item.status && <StatusBadge status="neutral">{statusLabel(item.status)}</StatusBadge>}
            </div>
            <Button size="sm" variant="ghost" disabled={pending} aria-label={`Unlink ${item.title}`} onClick={() => mutate(item.id, "unlink")}>Unlink</Button>
          </li>
        })}
      </ul>}
      {view.canLink && <Button className="self-start" size="sm" variant="outline" disabled={pending} onClick={() => { setSelected(null); setSearch(""); setOpen(true) }}>Link existing {noun}</Button>}
      {pending && <p role="status" className="text-xs text-muted-foreground">Saving link…</p>}
    </>}
    {error && <div><p role="alert" className="text-sm text-destructive">{error}</p><Button size="sm" variant="ghost" onClick={() => void load(search)}>Retry</Button></div>}
    <Dialog open={open} onOpenChange={(next) => { if (!pending) setOpen(next) }}>
      <DialogContent>
        <form className="flex min-w-0 flex-col gap-4" onSubmit={(event) => { event.preventDefault(); if (selected) mutate(selected, "link") }}>
          <DialogHeader><DialogTitle>Link existing {noun}</DialogTitle></DialogHeader>
          <Label htmlFor={idBase}>{capitalize(noun)}</Label>
          <Combobox items={(view?.candidates ?? []).map((item) => ({ value: item.id, label: `${item.title}${item.status ? ` · ${statusLabel(item.status)}` : ""} · ${item.id}`, render: <span className="block min-w-0 whitespace-normal break-words"><span className="block">{item.title}</span><span className="block text-xs text-muted-foreground">{item.status ? `${statusLabel(item.status)} · ` : ""}{item.id}</span></span> }))} value={selected} onValueChange={setSelected} inputValue={search} onInputValueChange={(value, details) => {
            // Base UI emits input-clear when the popup unmounts after a choice.
            // Only a user edit should invalidate that choice and launch a search.
            if (details.reason === "input-change") { setSearch(value); setSearching(true); setSelected(null) }
          }} filter={null} disabled={pending}>
            <ComboboxTrigger id={idBase} className="w-full min-w-0"><ComboboxValue placeholder={`Select ${noun}…`} /></ComboboxTrigger>
            <ComboboxContent className="max-w-[calc(100vw-3rem)]" inputPlaceholder={`Search ${plural}…`} emptyMessage={searching ? "Searching…" : "No available matches."} />
          </Combobox>
          <p className="text-xs text-muted-foreground">Search by name. Up to 50 matches are shown; records that are already linked or cannot take a new link are excluded.</p>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter><Button type="submit" size="sm" disabled={pending || !selected || searching}>{pending ? "Linking…" : `Link ${noun}`}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </section>
}
