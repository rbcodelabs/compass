"use client"

import { useState, useTransition } from "react"
import { Bookmark, Check, ChevronDown, Pencil, Trash2, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogAction,
} from "@/components/ui/alert-dialog"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  createRoadmapViewAction, deleteRoadmapViewAction, updateRoadmapViewAction,
} from "@/app/[orgSlug]/roadmap/actions"
import { MAX_VIEW_NAME_LENGTH, type RoadmapViewDisplay, type RoadmapViewFilters } from "@/lib/roadmap-views/schema"
import type { RoadmapViewRecord } from "@/lib/roadmap-views/service"

export type RoadmapViewState = { filters: RoadmapViewFilters; display: RoadmapViewDisplay }

type DialogState =
  | { kind: "create" }
  | { kind: "edit"; view: RoadmapViewRecord }
  | { kind: "delete"; view: RoadmapViewRecord }
  | null

type Props = {
  orgSlug: string
  /** null = the org-level cross-workspace roadmap; otherwise the workspace whose roadmap this is. */
  surfaceWorkspaceId: string | null
  views: RoadmapViewRecord[]
  savedViewId: string | null
  /** The URL state differs from the selected saved view. */
  modified: boolean
  /** The live (possibly unsaved) filter + display state; this is what "Save" captures. */
  state: RoadmapViewState
  canShare: boolean
  /** Navigate to a saved view (clean link) or, with null, to the unsaved default. */
  onSelect: (view: RoadmapViewRecord | null) => void
}

export function SavedViewsMenu({ orgSlug, surfaceWorkspaceId, views, savedViewId, modified, state, canShare, onSelect }: Props) {
  const [dialog, setDialog] = useState<DialogState>(null)
  const [name, setName] = useState("")
  const [shared, setShared] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const current = views.find((v) => v.id === savedViewId) ?? null
  const mine = views.filter((v) => v.isOwner && v.visibility === "PERSONAL")
  const sharedViews = views.filter((v) => v.visibility === "SHARED")

  function openCreate() {
    setName("")
    setShared(false)
    setError(null)
    setDialog({ kind: "create" })
  }

  function openEdit(view: RoadmapViewRecord) {
    setName(view.name)
    setShared(view.visibility === "SHARED")
    setError(null)
    setDialog({ kind: "edit", view })
  }

  function submit() {
    if (!dialog || dialog.kind === "delete") return
    const visibility = shared ? "SHARED" : "PERSONAL"
    setError(null)
    startTransition(async () => {
      if (dialog.kind === "create") {
        const result = await createRoadmapViewAction(orgSlug, surfaceWorkspaceId, { name, visibility, ...state })
        if (!result.ok) return setError(result.error)
        setDialog(null)
        onSelect(result.view)
      } else {
        // Renaming/re-sharing keeps the view's own saved state; it must not capture unsaved edits.
        const { view } = dialog
        const result = await updateRoadmapViewAction(orgSlug, surfaceWorkspaceId, view.id, {
          name, visibility, filters: view.filters, display: view.display,
        })
        if (!result.ok) return setError(result.error)
        setDialog(null)
      }
    })
  }

  function saveChanges() {
    if (!current) return
    setError(null)
    startTransition(async () => {
      const result = await updateRoadmapViewAction(orgSlug, surfaceWorkspaceId, current.id, {
        name: current.name, visibility: current.visibility, ...state,
      })
      if (!result.ok) return setError(result.error)
      onSelect(result.view)
    })
  }

  function confirmDelete() {
    if (dialog?.kind !== "delete") return
    const { view } = dialog
    startTransition(async () => {
      const result = await deleteRoadmapViewAction(orgSlug, surfaceWorkspaceId, view.id)
      if (!result.ok) return setError(result.error)
      setDialog(null)
      if (view.id === savedViewId) onSelect(null)
    })
  }

  const renderView = (view: RoadmapViewRecord) => (
    <DropdownMenuItem key={view.id} onClick={() => onSelect(view)} data-testid="saved-view-option">
      <span className="flex size-4 shrink-0 items-center justify-center">
        {view.id === savedViewId && <Check className="size-3.5" />}
      </span>
      <span className="min-w-0 flex-1 truncate">{view.name}</span>
      {view.visibility === "SHARED" && <Users className="size-3.5 shrink-0 text-text-subtle" aria-label="Shared" />}
    </DropdownMenuItem>
  )

  return (
    <div className="flex items-center gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="min-h-11 md:min-h-0" data-testid="saved-views-trigger" />}>
          <Bookmark />
          <span className="max-w-40 truncate">{current ? current.name : "Views"}</span>
          {current && modified && <span className="text-text-subtle">(modified)</span>}
          <ChevronDown />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuItem onClick={() => onSelect(null)}>
            <span className="flex size-4 shrink-0 items-center justify-center">
              {!current && <Check className="size-3.5" />}
            </span>
            Default view
          </DropdownMenuItem>
          {sharedViews.length > 0 && (
            <DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Shared</DropdownMenuLabel>
              {sharedViews.map(renderView)}
            </DropdownMenuGroup>
          )}
          {mine.length > 0 && (
            <DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>My views</DropdownMenuLabel>
              {mine.map(renderView)}
            </DropdownMenuGroup>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={openCreate} data-testid="save-view-new">
            Save current filters as new view…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {current?.isOwner && modified && (
        <Button size="sm" onClick={saveChanges} disabled={pending} data-testid="save-view-changes">
          Save changes
        </Button>
      )}
      {current?.isOwner && (
        <Button variant="ghost" size="icon-sm" aria-label={`Edit view ${current.name}`} onClick={() => openEdit(current)}>
          <Pencil />
        </Button>
      )}
      {current?.canDelete && (
        <Button variant="ghost" size="icon-sm" aria-label={`Delete view ${current.name}`} onClick={() => { setError(null); setDialog({ kind: "delete", view: current }) }}>
          <Trash2 />
        </Button>
      )}
      {!dialog && error && <span role="alert" className="text-xs text-destructive">{error}</span>}

      <Dialog open={dialog?.kind === "create" || dialog?.kind === "edit"} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent>
          <form
            onSubmit={(e) => { e.preventDefault(); submit() }}
            className="grid gap-4"
          >
            <DialogHeader>
              <DialogTitle>{dialog?.kind === "edit" ? "Edit view" : "Save view"}</DialogTitle>
              <DialogDescription>
                {dialog?.kind === "edit"
                  ? "Rename this view or change who can see it."
                  : "Saves the current filters, grouping and sort so you can come back to them."}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor="roadmap-view-name">Name</Label>
              <Input
                id="roadmap-view-name"
                value={name}
                maxLength={MAX_VIEW_NAME_LENGTH}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                required
              />
            </div>
            {canShare && (
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="roadmap-view-shared" className="flex flex-col items-start gap-0.5">
                  <span>Share with everyone</span>
                  <span className="text-xs font-normal text-text-subtle">
                    {surfaceWorkspaceId ? "Everyone in this workspace" : "Everyone in the organization"} can use this view. They still only see items from workspaces they can access.
                  </span>
                </Label>
                <Switch id="roadmap-view-shared" checked={shared} onCheckedChange={setShared} />
              </div>
            )}
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
              <Button type="submit" disabled={pending || !name.trim()}>{pending ? "Saving…" : "Save"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={dialog?.kind === "delete"} onOpenChange={(open) => !open && setDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete view?</AlertDialogTitle>
            <AlertDialogDescription>
              “{dialog?.kind === "delete" ? dialog.view.name : ""}” will be removed
              {dialog?.kind === "delete" && dialog.view.visibility === "SHARED" ? " for everyone it is shared with" : ""}. Roadmap items are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={(e) => { e.preventDefault(); confirmDelete() }} disabled={pending}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
