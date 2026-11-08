"use client"

// Composer attach controls: upload a file, or pin a workspace item (opportunity, solution, doc, task…) into the
// message. Presentational + the two network calls (upload, workspace search); AgentChat owns the attached list.

import { useEffect, useRef, useState } from "react"
import { AtSign, Loader2, Paperclip, Search } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useLabels } from "@/components/thinking-model/thinking-model-provider"
import type { WorkspaceSearchItem, WorkspaceSearchResponse } from "@/lib/workspace-search"
import type { DriveSearchHit, DriveSearchOutcome } from "@/lib/agent-drive-search"
import type { GoogleResourceRef } from "@/lib/agent-google-resources"

export const UPLOAD_MAX_BYTES = 4 * 1024 * 1024
export const MAX_UPLOADS = 5
export const MAX_CONTEXT_ITEMS = 10

export type AttachedUpload = { ref: string; name: string; size: number }
export type AttachedItem = { type: string; id: string; title: string; typeLabel: string }

const btn = "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"

/** Shared by the attach button and drag-and-drop onto the panel. Reports failures through onError; never throws. */
export async function uploadAgentFiles({ files, workspaceId, uploadCount, onUploaded, onError }: {
  files: FileList | File[]
  workspaceId: string
  uploadCount: number
  onUploaded: (upload: AttachedUpload) => void
  onError: (message: string) => void
}): Promise<void> {
  try {
    let count = uploadCount
    for (const file of Array.from(files)) {
      if (count >= MAX_UPLOADS) { onError(`You can attach up to ${MAX_UPLOADS} files per message.`); break }
      if (file.size > UPLOAD_MAX_BYTES) { onError(`${file.name} is larger than ${UPLOAD_MAX_BYTES / 1024 / 1024} MB.`); continue }
      const form = new FormData()
      form.set("workspaceId", workspaceId)
      form.set("file", file)
      const res = await fetch("/api/agent/attachments", { method: "POST", body: form })
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        onError(body?.error ?? `Upload failed (${res.status}).`)
        continue
      }
      onUploaded(await res.json() as AttachedUpload)
      count++
    }
  } catch {
    onError("Upload failed. Check your connection and try again.")
  }
}

type Props = {
  workspaceId: string
  orgSlug: string
  workspaceSlug: string
  disabled?: boolean
  uploadCount: number
  items: AttachedItem[]
  /** Google Drive is connected for this user: the search also looks in Drive. */
  driveConnected?: boolean
  /** Drive files already chipped, so they are not offered twice. */
  googleResources?: GoogleResourceRef[]
  onPickGoogle?: (ref: GoogleResourceRef) => void
  onUploaded: (upload: AttachedUpload) => void
  onPickItem: (item: AttachedItem) => void
  onError: (message: string) => void
}

export function AttachMenu({ workspaceId, orgSlug, workspaceSlug, disabled, uploadCount, items, driveConnected, googleResources = [], onPickGoogle, onUploaded, onPickItem, onError }: Props) {
  const labels = useLabels()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<WorkspaceSearchItem[]>([])
  const [searching, setSearching] = useState(false)
  const [driveHits, setDriveHits] = useState<DriveSearchHit[]>([])
  const [driveSearching, setDriveSearching] = useState(false)
  const [driveUnavailable, setDriveUnavailable] = useState(false)

  const upload = async (files: FileList | File[] | null) => {
    if (!files?.length) return
    setUploading(true)
    try {
      await uploadAgentFiles({ files, workspaceId, uploadCount, onUploaded, onError })
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  useEffect(() => {
    const q = query.trim()
    if (!open || q.length < 2) { setResults([]); setSearching(false); return }
    const controller = new AbortController()
    setSearching(true)
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/workspace-search?${new URLSearchParams({ orgSlug, workspaceSlug, q })}`, { signal: controller.signal })
        if (!res.ok) throw new Error(String(res.status))
        const data = await res.json() as WorkspaceSearchResponse
        setResults(data.groups.filter((g) => g.type !== "help").flatMap((g) => g.items.slice(0, 5)).filter((i) => i.type !== "help"))
      } catch {
        if (!controller.signal.aborted) setResults([])
      } finally {
        if (!controller.signal.aborted) setSearching(false)
      }
    }, 200)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [open, query, orgSlug, workspaceSlug])

  // Google Drive runs on its own request so a slow Drive never holds up the workspace results.
  useEffect(() => {
    const q = query.trim()
    setDriveUnavailable(false)
    if (!open || !driveConnected || !onPickGoogle || q.length < 2) { setDriveHits([]); setDriveSearching(false); return }
    const controller = new AbortController()
    setDriveSearching(true)
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch("/api/agent/drive-search?" + new URLSearchParams({ workspaceId, q }), { signal: controller.signal })
        if (!res.ok) throw new Error(String(res.status))
        const data = await res.json() as DriveSearchOutcome
        setDriveHits(data.status === "ok" ? data.hits : [])
        setDriveUnavailable(data.status !== "ok")
      } catch {
        if (!controller.signal.aborted) { setDriveHits([]); setDriveUnavailable(true) }
      } finally {
        if (!controller.signal.aborted) setDriveSearching(false)
      }
    }, 300)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [open, query, workspaceId, driveConnected, onPickGoogle])

  const full = items.length >= MAX_CONTEXT_ITEMS
  return (
    <div className="flex items-center gap-0.5">
      <input ref={fileRef} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
      <button type="button" className={btn} disabled={disabled || uploading || uploadCount >= MAX_UPLOADS} onClick={() => fileRef.current?.click()} aria-label="Attach a file" title="Attach a file (up to 4 MB)">
        {uploading ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Paperclip className="size-4" aria-hidden="true" />}
      </button>
      <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery("") }}>
        <PopoverTrigger render={<button type="button" className={btn} disabled={disabled || full} aria-label="Add a workspace item to the chat" title="Add a workspace item" />}>
          <AtSign className="size-4" aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent align="start" side="top" className="w-80 p-0">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${labels.opportunity.plural.toLowerCase()}, ${labels.solution.plural.toLowerCase()}, docs, tasks…`} aria-label="Search the workspace" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
            {searching && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" />}
          </div>
          <ul className="max-h-64 overflow-y-auto py-1">
            {results.map((r) => {
              const already = items.some((i) => i.id === r.id && i.type === r.type)
              return (
                <li key={`${r.type}:${r.id}`}>
                  <button type="button" disabled={already} onClick={() => { onPickItem({ type: r.type, id: r.id, title: r.title, typeLabel: r.displayId ?? r.type }); setOpen(false); setQuery("") }} className="flex w-full min-w-0 flex-col px-3 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50">
                    <span className="truncate font-medium">{r.title}</span>
                    <span className="truncate text-xs text-muted-foreground">{[r.displayId ?? r.type, r.context].filter(Boolean).join(" · ")}</span>
                  </button>
                </li>
              )
            })}
            {driveHits.length > 0 && <li className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">Google Drive</li>}
            {driveHits.map((hit) => {
              const already = googleResources.some((g) => g.fileId === hit.fileId)
              return (
                <li key={"drive:" + hit.fileId}>
                  <button type="button" disabled={already} onClick={() => { onPickGoogle?.(hit); setOpen(false); setQuery("") }} className="flex w-full min-w-0 flex-col px-3 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50">
                    <span className="truncate font-medium">{hit.title}</span>
                    <span className="truncate text-xs text-muted-foreground">{hit.label}</span>
                  </button>
                </li>
              )
            })}
            {driveSearching && <li className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" aria-hidden="true" />Searching Google Drive…</li>}
            {driveUnavailable && <li className="px-3 py-1.5 text-xs text-muted-foreground">Google Drive could not be searched right now. You can still paste a link.</li>}
            {query.trim().length >= 2 && !searching && !driveSearching && results.length === 0 && driveHits.length === 0 && <li className="px-3 py-3 text-sm text-muted-foreground">No matches.</li>}
            {query.trim().length < 2 && <li className="px-3 py-3 text-sm text-muted-foreground">Type at least 2 characters.</li>}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  )
}
