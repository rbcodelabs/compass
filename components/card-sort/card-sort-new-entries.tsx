"use client"

import { useLabels } from "@/components/thinking-model/thinking-model-provider"
import { useState } from "react"
import Link from "next/link"
import { Plus } from "lucide-react"

import { EntityCard } from "@/components/patterns/entity-card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useCardSortProposals } from "./use-card-sort-proposals"

/**
 * "Propose new entry" for OPPORTUNITY rounds.
 *
 * Nothing here decides visibility. `entries` arrives already filtered by the
 * server (listCardSortNewEntries): on an OPEN round a participant receives only
 * their own, the facilitator receives everyone's. Filtering in this component
 * would put the blind-vote rule in the browser.
 *
 * A request is not an Opportunity. It becomes one only when the facilitator
 * accepts it, which is why the copy below says "requested" and never "added".
 *
 * Three pieces:
 *  - ProposeNewEntryButton: the dialog, used in the kanban toolbar.
 *  - NewEntryCard: a pending request rendered as a card inside a kanban column.
 *  - CardSortNewEntries: the standalone list, kept for the table view, which has
 *    no columns to put a card in.
 */

export type NewEntryItem = {
  id: string
  userName: string
  title: string
  description: string | null
  suggestedValue: string | null
  status: "PENDING" | "ACCEPTED" | "REJECTED"
  acceptedObjectId: string | null
  resolutionNote: string | null
  isMine: boolean
}

type Option = { value: string; label: string }

type RoundRef = { orgSlug: string; workspaceSlug: string; roundId: string }

const STATUS_LABEL = { PENDING: "Pending", ACCEPTED: "Accepted", REJECTED: "Rejected" } as const

const labelFor = (options: Option[], value: string | null) =>
  value ? (options.find((option) => option.value === value)?.label ?? value) : null

// ── Propose dialog ──────────────────────────────────────────────────────────

export function ProposeNewEntryButton({
  orgSlug,
  workspaceSlug,
  roundId,
  options,
}: RoundRef & { options: Option[] }) {
  const labels = useLabels()
  const { proposeEntry, error, setError, working } = useCardSortProposals({
    orgSlug,
    workspaceSlug,
    roundId,
  })
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [suggestedValue, setSuggestedValue] = useState("")

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const result = await proposeEntry({
      title,
      description: description || undefined,
      suggestedValue: suggestedValue || undefined,
    })
    if (result) {
      setTitle("")
      setDescription("")
      setSuggestedValue("")
      setOpen(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setError(null)
      }}
    >
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Plus />
        Propose new entry
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{`Propose a new ${labels.opportunity.lower}`}</DialogTitle>
            <DialogDescription>
              {`This is a request, not ${labels.opportunity.indefinite} yet. It is only created if the person running this round accepts it. Until the round is revealed, only you and they can see it.`}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-entry-title">Title</Label>
            <Input
              id="new-entry-title"
              value={title}
              maxLength={255}
              required
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-entry-description">Why it belongs (optional)</Label>
            <Textarea
              id="new-entry-description"
              value={description}
              maxLength={2000}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-entry-bucket">Where you would put it (optional)</Label>
            <select
              id="new-entry-bucket"
              value={suggestedValue}
              onChange={(event) => setSuggestedValue(event.target.value)}
              className="h-8 rounded-lg border border-border-default bg-background px-2 text-sm"
            >
              <option value="">No suggestion</option>
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={working || title.trim().length === 0}>
              {working ? "Sending…" : "Send request"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── Card in a column ────────────────────────────────────────────────────────

/**
 * A pending request, drawn as a card in the column its proposer suggested.
 *
 * Deliberately not draggable and not a real card: it is not an object yet, so
 * there is nothing to move, and it never counts toward a column's official
 * total. The dashed border plus the "Requested" badge is what says so.
 */
export function NewEntryCard({
  orgSlug,
  workspaceSlug,
  roundId,
  entry,
  canResolve,
  canWithdraw,
}: RoundRef & {
  entry: NewEntryItem
  canResolve: boolean
  canWithdraw: boolean
}) {
  const { withdrawEntry, resolveEntry, error, working } = useCardSortProposals({
    orgSlug,
    workspaceSlug,
    roundId,
  })
  const showWithdraw = entry.isMine && canWithdraw
  const showActions = canResolve || showWithdraw

  return (
    <EntityCard
      data-new-entry-id={entry.id}
      title={entry.title}
      description={entry.description ?? undefined}
      status={<Badge variant="outline">Requested</Badge>}
      className="w-full border-2 border-dashed border-status-info/60 bg-status-info-surface p-3 shadow-none"
    >
      <div className="mt-2 flex flex-col gap-2">
        <span className="text-xs text-text-secondary">
          New entry requested by {entry.isMine ? "you" : entry.userName}
        </span>
        {showActions && (
          <div className="flex flex-wrap gap-1">
            {canResolve && (
              <>
                <Button
                  size="sm"
                  disabled={working}
                  onClick={() => resolveEntry(entry.id, "accept")}
                >
                  Accept
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={working}
                  onClick={() => resolveEntry(entry.id, "reject")}
                >
                  Reject
                </Button>
              </>
            )}
            {showWithdraw && (
              <Button
                size="sm"
                variant="ghost"
                disabled={working}
                onClick={() => withdrawEntry(entry.id)}
              >
                Withdraw
              </Button>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </EntityCard>
  )
}

// ── Standalone list (table view) ────────────────────────────────────────────

export function CardSortNewEntries({
  orgSlug,
  workspaceSlug,
  roundId,
  canPropose,
  canResolve,
  options,
  entries,
}: RoundRef & {
  /** OPPORTUNITY round that is still OPEN. */
  canPropose: boolean
  /** The facilitator, while the round is not CLOSED. */
  canResolve: boolean
  options: Option[]
  entries: NewEntryItem[]
}) {
  const labels = useLabels()
  const { withdrawEntry, resolveEntry, error, working } = useCardSortProposals({
    orgSlug,
    workspaceSlug,
    roundId,
  })

  if (!canPropose && entries.length === 0) return null

  return (
    <section
      aria-label="Proposed new entries"
      className="mb-4 flex flex-col gap-2 rounded-md bg-surface-panel p-3 ring-1 ring-border-default"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Proposed new entries</h2>
        {canPropose && (
          <ProposeNewEntryButton
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            roundId={roundId}
            options={options}
          />
        )}
      </div>

      {entries.length === 0 ? (
        <p className="text-xs text-text-secondary">Nothing requested yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-wrap items-start justify-between gap-2 rounded-md bg-background p-2 ring-1 ring-border-default"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{entry.title}</span>
                  <Badge variant="outline">{STATUS_LABEL[entry.status]}</Badge>
                </div>
                <span className="text-xs text-text-secondary">
                  {entry.isMine ? "You" : entry.userName}
                  {entry.suggestedValue && ` · suggests ${labelFor(options, entry.suggestedValue)}`}
                </span>
                {entry.description && <p className="text-xs">{entry.description}</p>}
                {entry.resolutionNote && (
                  <p className="text-xs text-text-secondary">Note: {entry.resolutionNote}</p>
                )}
                {entry.status === "ACCEPTED" && entry.acceptedObjectId && (
                  <Link
                    className="text-xs underline"
                    href={`/${orgSlug}/${workspaceSlug}/discovery/${entry.acceptedObjectId}`}
                  >
                    {`Open the new ${labels.opportunity.lower}`}
                  </Link>
                )}
              </div>
              {entry.status === "PENDING" && (
                <div className="flex gap-1">
                  {canResolve && (
                    <>
                      <Button
                        size="sm"
                        disabled={working}
                        onClick={() => resolveEntry(entry.id, "accept")}
                      >
                        Accept
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={working}
                        onClick={() => resolveEntry(entry.id, "reject")}
                      >
                        Reject
                      </Button>
                    </>
                  )}
                  {entry.isMine && canPropose && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={working}
                      onClick={() => withdrawEntry(entry.id)}
                    >
                      Withdraw
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
