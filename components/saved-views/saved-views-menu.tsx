"use client"

import { useState, useTransition } from "react"
import { Bookmark, Check, ChevronDown, Pencil, RotateCcw, Trash2, Users } from "lucide-react"
import { useRouter } from "next/navigation"
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

/**
 * Loaded on first use, not at module load: the actions module pulls in auth (next-auth), and
 * importing it eagerly would drag that into every client bundle and test that merely renders a header.
 */
const savedViewActions = () => import("@/app/[orgSlug]/saved-views-actions")
import { MAX_VIEW_NAME_LENGTH } from "@/lib/roadmap-views/schema"
import type { SavedViewRecord } from "@/lib/saved-views/service"
import { SURFACES, type SavedViewSurface } from "@/lib/saved-views/surfaces"

/** The live (possibly unsaved) filter + display state; this is what "Save" captures. */
export type SavedViewState = { filters: unknown; display: unknown }

type DialogState<V> =
  | { kind: "create" }
  | { kind: "edit"; view: V }
  | { kind: "delete"; view: V }
  | null

type Props<V extends SavedViewRecord> = {
  orgSlug: string
  surface: SavedViewSurface
  /** null = an org-level surface (the cross-workspace roadmap); otherwise the workspace this surface belongs to. */
  surfaceWorkspaceId: string | null
  views: V[]
  savedViewId: string | null
  /** The URL state differs from the selected saved view. */
  modified: boolean
  state: SavedViewState
  /** The actor may share on this surface. Ignored for surfaces that do not support sharing at all. */
  canShare: boolean
  /** False for read-only members: they can use views but not create, change or delete them. Defaults to true. */
  canSave?: boolean
  /** Adds the board-style affordances: a Reset action and a "Modified" badge. The roadmap keeps its original look. */
  extendedActions?: boolean
  /** Said in the delete confirmation, after the view name ("... will be removed. <note>"). */
  deleteNote: string
  /** Navigate to a saved view (clean link) or, with null, to the unsaved default. */
  onSelect: (view: V | null) => void
}

export function SavedViewsMenu<V extends SavedViewRecord>({
  orgSlug, surface, surfaceWorkspaceId, views, savedViewId, modified, state, canShare, canSave = true,
  extendedActions = false, deleteNote, onSelect,
}: Props<V>) {
  const router = useRouter()
  const sharingAvailable = canShare && canSave && SURFACES[surface].sharing
  const [dialog, setDialog] = useState<DialogState<V>>(null)
  const [name, setName] = useState("")
  const [shared, setShared] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [pending, startTransition] = useTransition()

  const current = views.find((v) => v.id === savedViewId) ?? null
  const mine = views.filter((v) => v.isOwner && v.visibility === "PERSONAL")
  const sharedViews = views.filter((v) => v.visibility === "SHARED")

  function openCreate() {
    setName("")
    setShared(false)
    setError(null)
    setConflict(false)
    setDialog({ kind: "create" })
  }

  function openEdit(view: V) {
    setName(view.name)
    setShared(view.visibility === "SHARED")
    setError(null)
    setConflict(false)
    setDialog({ kind: "edit", view })
  }

  function fail(result: { error: string; code?: string }) {
    setError(result.error)
    setConflict(result.code === "CONFLICT")
  }

  function submit() {
    if (!dialog || dialog.kind === "delete") return
    const visibility = shared ? "SHARED" : "PERSONAL"
    setError(null)
    setConflict(false)
    startTransition(async () => {
      if (dialog.kind === "create") {
        const result = await (await savedViewActions()).createSavedViewAction(orgSlug, surface, surfaceWorkspaceId, { name, visibility, ...state })
        if (!result.ok) return fail(result)
        setDialog(null)
        onSelect(result.view as V)
      } else {
        // Renaming/re-sharing keeps the view's own saved state; it must not capture unsaved edits.
        const { view } = dialog
        const result = await (await savedViewActions()).updateSavedViewAction(orgSlug, surface, surfaceWorkspaceId, view.id, {
          name, visibility, filters: view.filters, display: view.display,
        }, view.updatedAt)
        if (!result.ok) return fail(result)
        setDialog(null)
      }
    })
  }

  function saveChanges() {
    if (!current) return
    setError(null)
    setConflict(false)
    startTransition(async () => {
      const result = await (await savedViewActions()).updateSavedViewAction(orgSlug, surface, surfaceWorkspaceId, current.id, {
        name: current.name, visibility: current.visibility, ...state,
      }, current.updatedAt)
      if (!result.ok) return fail(result)
      onSelect(result.view as V)
    })
  }

  function confirmDelete() {
    if (dialog?.kind !== "delete") return
    const { view } = dialog
    startTransition(async () => {
      const result = await (await savedViewActions()).deleteSavedViewAction(orgSlug, surface, surfaceWorkspaceId, view.id)
      if (!result.ok) return fail(result)
      setDialog(null)
      if (view.id === savedViewId) onSelect(null)
    })
  }

  const renderView = (view: V) => (
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
          {current && modified && (
            extendedActions
              ? <span data-testid="saved-view-modified" className="rounded-sm bg-surface-sunken px-1 text-xs text-text-secondary">Modified</span>
              : <span className="text-text-subtle">(modified)</span>
          )}
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
          {canSave && (
            <DropdownMenuItem onClick={openCreate} data-testid="save-view-new">
              Save current filters as new view…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {extendedActions && current && modified && (
        <Button variant="ghost" size="sm" onClick={() => onSelect(current)} data-testid="reset-view">
          <RotateCcw />
          Reset
        </Button>
      )}
      {canSave && current?.isOwner && modified && (
        <Button size="sm" onClick={saveChanges} disabled={pending} data-testid="save-view-changes">
          Save changes
        </Button>
      )}
      {canSave && current?.isOwner && (
        <Button variant="ghost" size="icon-sm" aria-label={`Edit view ${current.name}`} onClick={() => openEdit(current)}>
          <Pencil />
        </Button>
      )}
      {canSave && current?.canDelete && (
        <Button variant="ghost" size="icon-sm" aria-label={`Delete view ${current.name}`} onClick={() => { setError(null); setConflict(false); setDialog({ kind: "delete", view: current }) }}>
          <Trash2 />
        </Button>
      )}
      {!dialog && error && (
        <span role="alert" className="flex items-center gap-1.5 text-xs text-destructive">
          {error}
          {conflict && (
            <Button variant="outline" size="xs" onClick={() => { setError(null); setConflict(false); router.refresh() }} data-testid="reload-view">
              Reload
            </Button>
          )}
        </span>
      )}

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
            {sharingAvailable && (
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
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
                {conflict && (
                  <Button type="button" variant="link" size="xs" onClick={() => { setDialog(null); setError(null); setConflict(false); router.refresh() }}>
                    Reload
                  </Button>
                )}
              </p>
            )}
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
              {dialog?.kind === "delete" && dialog.view.visibility === "SHARED" ? " for everyone it is shared with" : ""}. {deleteNote}
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
