"use client"

import React, { useCallback, useEffect, useId, useRef, useState, useTransition } from "react"
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
/** At least 44px tall on a phone; the compact 28px size only from the sm breakpoint up. */
const TOUCH = "max-sm:min-h-11"
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

export type LinkedEntitiesTarget = { linkType: string; entityType: string; entityId: string }

/**
 * Shared section for one registry link type on one entity, e.g. an experiment's "Informed by" studies or a
 * study's "Informs" experiments. Every word that names the relationship (heading, noun, direction) comes from
 * the view the server builds out of the registry, so a new link type adds no copy here. Renders nothing when
 * the type does not apply (feature flag off, entity not eligible) and only offers candidates the service
 * would accept.
 */
export function LinkedEntitiesSection({ orgSlug, workspaceSlug, target, title, refreshKey, fullWidth }: { orgSlug: string; workspaceSlug: string; target: LinkedEntitiesTarget; /** Changing this reloads the section (e.g. the viewed record was archived, which changes whether it can take a new link). */ refreshKey?: string; /** Fill the container instead of capping at a readable column width (for pages whose other cards are full width). */ fullWidth?: boolean; /** Overrides the registry label as the heading (e.g. "Linked experiments"). */ title?: string }) {
  const [view, setView] = useState<LinkedEntitiesView | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [searching, setSearching] = useState(false)
  const [pending, startTransition] = useTransition()
  const request = useRef(0)
  const loadedQuery = useRef("")
  const headingRef = useRef<HTMLHeadingElement>(null)
  const headingId = useId()
  const { linkType, entityType, entityId } = target

  const load = useCallback(async (query = "") => {
    const current = ++request.current
    loadedQuery.current = query
    setSearching(true)
    try {
      const result = await readEntityLinks(orgSlug, workspaceSlug, { linkType, entityType, entityId }, query)
      if (current !== request.current) return
      if (result.ok) { setView(result.view); setLoaded(true); setError(null) } else setError("Could not load links. Please retry.")
    } catch {
      if (current === request.current) setError("Could not load links. Please retry.")
    } finally { if (current === request.current) setSearching(false) }
  }, [orgSlug, workspaceSlug, linkType, entityType, entityId])

  // A different target starts from scratch; the same target only re-reads (below), so nothing flashes blank.
  useEffect(() => {
    setView(null)
    setLoaded(false)
    void load()
    return () => { request.current++ }
  }, [load])
  const firstRefresh = useRef(true)
  useEffect(() => {
    if (firstRefresh.current) { firstRefresh.current = false; return }
    void load()
  }, [refreshKey, load])
  useEffect(() => {
    // The dialog opens with the list already loaded for the empty query, so only a changed query needs a read.
    if (!open || search === loadedQuery.current) return
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
        // The row that held focus is gone after an unlink; a link's own trigger gets focus back from the dialog.
        if (operation === "unlink") headingRef.current?.focus()
      } catch { setError("Could not change the link. Refresh and try again.") }
    })
  }

  // Not applicable here (flag off, entity not eligible): render nothing rather than an empty shell.
  if (loaded && !view && !error) return null

  const noun = view?.otherNoun ?? "item"
  const plural = view?.otherNounPlural ?? "items"
  const heading = title ?? view?.label ?? "Links"
  const idBase = `linked-entities-${linkType}-${entityId}`

  const statusText = !view && !error ? "Loading links…" : pending ? "Saving link…" : ""
  // Two rows with the same title would read identically to a screen reader, so only then is a short id added.
  const titleCounts = new Map<string, number>()
  for (const item of view?.linked ?? []) titleCounts.set(item.title, (titleCounts.get(item.title) ?? 0) + 1)
  const unlinkLabel = (item: { id: string; title: string }) => (titleCounts.get(item.title) ?? 0) > 1 ? `Unlink ${item.title} (${item.id.slice(0, 8)})` : `Unlink ${item.title}`

  return <section role="region" aria-labelledby={headingId} data-link-type={linkType} className={`flex flex-col gap-3 rounded-lg border bg-surface-panel p-4${fullWidth ? "" : " max-w-3xl"}`}>
    <div>
      {/* tabIndex -1: focus lands here after an unlink removes the row that had it. */}
      <h2 id={headingId} ref={headingRef} tabIndex={-1} aria-label={title ? undefined : `${heading} ${plural}`} className="text-base font-semibold outline-none">{heading}</h2>
      <p className="text-xs text-muted-foreground">{capitalize(plural)} linked to this record. Linking doesn&apos;t change either record.</p>
    </div>
    {/* Always mounted: a live region that appears together with its text is often not announced. */}
    <p role="status" className={statusText ? "text-sm text-muted-foreground" : "sr-only"}>{statusText}</p>
    {view && <>
      {view.linked.length === 0 ? <p className="text-sm text-muted-foreground">No {plural} linked yet.</p> : <ul className="flex flex-col gap-2">
        {view.linked.map((item) => {
          const path = entityPath(item.type, item.id)
          return <li key={item.id} className="flex min-w-0 items-start justify-between gap-2 rounded-lg border p-3">
            <div className="min-w-0 space-y-1">
              {path ? <Link className="block break-words text-sm font-medium underline underline-offset-2" href={`/${orgSlug}/${workspaceSlug}/${path}`}>{item.title}</Link> : <span className="block break-words text-sm font-medium">{item.title}</span>}
              {item.status && <StatusBadge status="neutral">{statusLabel(item.status)}</StatusBadge>}
            </div>
            <Button className={TOUCH} size="sm" variant="ghost" disabled={pending} aria-label={unlinkLabel(item)} onClick={() => mutate(item.id, "unlink")}>Unlink</Button>
          </li>
        })}
      </ul>}
      {view.canLink && <Button className={`self-start ${TOUCH}`} size="sm" variant="outline" disabled={pending} onClick={() => { setSelected(null); setSearch(""); setOpen(true) }}>Link existing {noun}</Button>}
    </>}
    {/* One error, in one place: inside the dialog while it is open, otherwise here. */}
    {error && !open && <div><p role="alert" className="text-sm text-destructive">{error}</p><Button className={TOUCH} size="sm" variant="ghost" onClick={() => void load(search)}>Retry</Button></div>}
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
          <DialogFooter><Button className={TOUCH} type="submit" size="sm" disabled={pending || !selected || searching}>{pending ? "Linking…" : `Link ${noun}`}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </section>
}
