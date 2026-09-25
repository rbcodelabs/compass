"use client"

import React, { useCallback, useEffect, useRef, useState, useTransition } from "react"
import Link from "next/link"
import { readExperimentStudyLinks, changeExperimentStudyLink } from "@/app/[orgSlug]/[workspaceSlug]/experiments/research-actions"
import type { ResearchLinkTarget, ResearchLinksData } from "@/lib/experiment-research-links"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { StatusBadge } from "@/components/patterns/status-badge"
import { Combobox, ComboboxContent, ComboboxTrigger, ComboboxValue } from "@/components/ui/combobox"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

const statusLabel = (status: string) => status.toLowerCase().replaceAll("_", " ").replace(/^./, c => c.toUpperCase())

export function ExperimentResearchLinksSection({ orgSlug, workspaceSlug, target }: { orgSlug: string; workspaceSlug: string; target: ResearchLinkTarget }) {
  const [data, setData] = useState<ResearchLinksData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [searching, setSearching] = useState(false)
  const [pending, startTransition] = useTransition()
  const request = useRef(0)
  const kind = target.type === "experiment" ? "study" : "experiment"
  const heading = kind === "study" ? "Research studies" : "Experiments"
  const load = useCallback(async (query = "") => {
    const current = ++request.current
    setSearching(true)
    try {
      const next = await readExperimentStudyLinks(orgSlug, workspaceSlug, { type: target.type, id: target.id }, query)
      if (current === request.current) { setData(next); setError(null) }
    } catch {
      if (current === request.current) setError("Could not load links. Please retry.")
    } finally { if (current === request.current) setSearching(false) }
  }, [orgSlug, workspaceSlug, target.type, target.id])

  useEffect(() => {
    setData(null)
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
        await changeExperimentStudyLink(orgSlug, workspaceSlug, target.type === "experiment" ? target.id : otherId, target.type === "study" ? target.id : otherId, operation)
        setSelected(null)
        setOpen(false)
        setSearch("")
        await load()
      } catch { setError("Could not change the link. Refresh and try again; archived studies cannot receive new links.") }
    })
  }

  return <section aria-label={heading} className="flex max-w-3xl flex-col gap-3 rounded-xl border bg-surface-panel p-4">
    <h2 className="text-sm font-semibold">{heading}</h2>
    <p className="text-xs text-muted-foreground">Link studies and experiments without changing study settings or experiment results.</p>
    {!data && !error && <p role="status" className="text-sm text-muted-foreground">Loading links…</p>}
    {data && <>
      {data.linked.length === 0 ? <p className="text-sm text-muted-foreground">No {kind === "study" ? "research studies" : "experiments"} linked yet.</p> : <ul className="flex flex-col gap-2">
        {data.linked.map(item => <li key={item.id} className="flex min-w-0 items-start justify-between gap-2 rounded-lg border p-3">
          <div className="min-w-0 space-y-1">
            <Link className="block break-words text-sm font-medium underline underline-offset-2" href={`/${orgSlug}/${workspaceSlug}/${kind === "study" ? "capture/studies" : "experiments"}/${item.id}`}>{item.title}</Link>
            <StatusBadge status="neutral">{statusLabel(item.status)}</StatusBadge>
          </div>
          <Button size="sm" variant="ghost" disabled={pending} aria-label={`Unlink ${item.title}`} onClick={() => mutate(item.id, "unlink")}>Unlink</Button>
        </li>)}
      </ul>}
      {data.canLink && <Button className="self-start" size="sm" variant="outline" disabled={pending} onClick={() => { setSelected(null); setSearch(""); setOpen(true) }}>Link existing {kind}</Button>}
      {pending && <p role="status" className="text-xs text-muted-foreground">Saving link…</p>}
    </>}
    {error && <div><p role="alert" className="text-sm text-destructive">{error}</p><Button size="sm" variant="ghost" onClick={() => void load(search)}>Retry</Button></div>}
    <Dialog open={open} onOpenChange={next => { if (!pending) setOpen(next) }}>
      <DialogContent>
        <form className="flex min-w-0 flex-col gap-4" onSubmit={event => { event.preventDefault(); if (selected) mutate(selected, "link") }}>
          <DialogHeader><DialogTitle>Link existing {kind}</DialogTitle></DialogHeader>
          <Label htmlFor={`research-link-${target.id}`}>{kind === "study" ? "Study" : "Experiment"}</Label>
          <Combobox items={(data?.available ?? []).map(item => ({ value: item.id, label: `${item.title} · ${statusLabel(item.status)} · ${item.id}`, render: <span className="block min-w-0 whitespace-normal break-words"><span className="block">{item.title}</span><span className="block text-xs text-muted-foreground">{statusLabel(item.status)} · {item.id}</span></span> }))} value={selected} onValueChange={setSelected} inputValue={search} onInputValueChange={(value, details) => {
            // Base UI emits input-clear when the popup unmounts after a choice.
            // Only a user edit should invalidate that choice and launch a search.
            if (details.reason === "input-change") { setSearch(value); setSearching(true); setSelected(null) }
          }} filter={null} disabled={pending}>
            <ComboboxTrigger id={`research-link-${target.id}`} className="w-full min-w-0"><ComboboxValue placeholder={`Select ${kind === "study" ? "a study" : "an experiment"}…`} /></ComboboxTrigger>
            <ComboboxContent className="max-w-[calc(100vw-3rem)]" inputPlaceholder={kind === "study" ? "Search studies…" : "Search experiments…"} emptyMessage={searching ? "Searching…" : "No available matches."} />
          </Combobox>
          <p className="text-xs text-muted-foreground">Search by name. Up to 50 matches are shown; already linked records and archived studies are excluded.</p>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter><Button type="submit" size="sm" disabled={pending || !selected || searching}>{pending ? "Linking…" : `Link ${kind}`}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </section>
}
