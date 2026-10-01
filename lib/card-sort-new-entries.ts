import getPrisma from "@/lib/db"
import type { CustomFieldObjectType } from "@/lib/types"
import {
  CardSortError,
  canSeeOtherProposals,
  loadFactor,
  loadRound,
} from "@/lib/card-sort"
import { OPPORTUNITY_TITLE_MAX_LENGTH } from "@/lib/opportunity-draft"
import { createOpportunityWithLinks, OpportunityCreateError } from "@/lib/opportunity-create"

/**
 * Proposing NEW entries in a card sort round.
 *
 * A card sort moves existing objects between buckets. This lets a participant
 * say "the list is missing something" — but only in OPPORTUNITY rounds, and only
 * as a request. A CardSortNewEntry is not an Opportunity: nothing in the OST
 * changes until the round's facilitator accepts it, at which point the real
 * Opportunity is created. Rejected entries are kept for the record.
 *
 * ── Visibility ──────────────────────────────────────────────────────────────
 *
 * Follows the blind-vote rule exactly, through the same `canSeeOtherProposals`
 * the tally and the board use: while a round is OPEN the proposer sees their own
 * entries and the facilitator sees all of them; once it is REVEALED or CLOSED
 * everybody sees everything. A new entry is an opinion about what belongs on the
 * list, and seeing that three colleagues already asked for X is the same
 * anchoring a visible move proposal would be.
 *
 * ── The suggested bucket ────────────────────────────────────────────────────
 *
 * Optional, and never written to the official CustomFieldValue — card sort does
 * not write official values, and this is not an exception. On accept in an OPEN
 * round it becomes the proposer's ordinary CardSortProposal on the new
 * Opportunity (fromValue null, since a brand new object has no official value),
 * so it is tallied like any other vote.
 */

export const CARD_SORT_NEW_ENTRY_STATUSES = ["PENDING", "ACCEPTED", "REJECTED"] as const
export type CardSortNewEntryStatus = (typeof CARD_SORT_NEW_ENTRY_STATUSES)[number]

export const CARD_SORT_NEW_ENTRY_TITLE_MAX = OPPORTUNITY_TITLE_MAX_LENGTH
export const CARD_SORT_NEW_ENTRY_NOTE_MAX = 2000

/** Only these object types can be added to from inside a round. */
export function canProposeNewEntries(round: { objectType: string; state: string }): boolean {
  return round.objectType === "OPPORTUNITY" && round.state === "OPEN"
}

export type CardSortNewEntryView = {
  id: string
  userId: string
  userName: string
  title: string
  description: string | null
  suggestedValue: string | null
  status: CardSortNewEntryStatus
  acceptedObjectId: string | null
  resolutionNote: string | null
  resolvedAt: Date | null
  createdAt: Date
  isMine: boolean
}

const trimToNull = (value: string | null | undefined) => {
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed ? trimmed : null
}

function assertOpportunityRound(round: { objectType: string }) {
  if (round.objectType !== "OPPORTUNITY") {
    throw new CardSortError(
      "INVALID_FACTOR",
      `New entries can only be proposed in OPPORTUNITY rounds; this round sorts ${round.objectType} objects.`
    )
  }
}

/**
 * Record a new-entry request. Any workspace member may propose (membership is
 * enforced by the route's context, exactly as for move proposals).
 */
export async function proposeCardSortNewEntry({
  workspaceId,
  roundId,
  userId,
  title,
  description,
  suggestedValue,
}: {
  workspaceId: string
  roundId: string
  userId: string
  title: string
  description?: string | null
  suggestedValue?: string | null
}) {
  const prisma = getPrisma()
  const round = await loadRound(prisma, roundId, workspaceId)
  assertOpportunityRound(round)
  if (round.state !== "OPEN") {
    throw new CardSortError(
      "WRONG_STATE",
      `This round is ${round.state}. New entries can only be proposed while a round is OPEN.`
    )
  }

  const cleanTitle = trimToNull(title)
  if (!cleanTitle) throw new CardSortError("INVALID_VALUE", "A title is required.")
  if (cleanTitle.length > CARD_SORT_NEW_ENTRY_TITLE_MAX) {
    throw new CardSortError(
      "INVALID_VALUE",
      `Title must be ${CARD_SORT_NEW_ENTRY_TITLE_MAX} characters or fewer.`
    )
  }
  const cleanDescription = trimToNull(description)
  if (cleanDescription && cleanDescription.length > CARD_SORT_NEW_ENTRY_NOTE_MAX) {
    throw new CardSortError(
      "INVALID_VALUE",
      `Description must be ${CARD_SORT_NEW_ENTRY_NOTE_MAX} characters or fewer.`
    )
  }

  const cleanSuggested = trimToNull(suggestedValue)
  if (cleanSuggested) {
    const factor = await loadFactor(prisma, {
      workspaceId,
      fieldDefinitionId: round.fieldDefinitionId,
    })
    if (!factor.options.some((option) => option.value === cleanSuggested)) {
      throw new CardSortError(
        "INVALID_VALUE",
        `"${cleanSuggested}" is not an option on ${factor.name}. Valid options: ${factor.options
          .map((option) => option.value)
          .join(", ")}`
      )
    }
  }

  return prisma.cardSortNewEntry.create({
    data: {
      roundId,
      userId,
      title: cleanTitle,
      description: cleanDescription,
      suggestedValue: cleanSuggested,
      status: "PENDING",
    },
  })
}

/**
 * Withdraw the caller's own PENDING entry.
 *
 * Scoped to userId and status in the delete filter rather than checked after a
 * lookup, so there is no path on which one participant removes another's entry,
 * or erases a decision the facilitator already made.
 */
export async function withdrawCardSortNewEntry({
  workspaceId,
  roundId,
  userId,
  entryId,
}: {
  workspaceId: string
  roundId: string
  userId: string
  entryId: string
}) {
  const prisma = getPrisma()
  const round = await loadRound(prisma, roundId, workspaceId)
  if (round.state !== "OPEN") {
    throw new CardSortError(
      "WRONG_STATE",
      `This round is ${round.state}. New entries can only be withdrawn while a round is OPEN.`
    )
  }
  const deleted = await prisma.cardSortNewEntry.deleteMany({
    where: { id: entryId, roundId, userId, status: "PENDING" },
  })
  if (deleted.count === 0) {
    throw new CardSortError("NOT_FOUND", "You have no pending new entry with that id to withdraw.")
  }
  return { withdrawn: deleted.count }
}

async function loadFacilitatedRound(
  roundId: string,
  workspaceId: string,
  userId: string,
  verb: string
) {
  const prisma = getPrisma()
  const round = await loadRound(prisma, roundId, workspaceId)
  if (round.createdById !== userId) {
    throw new CardSortError("FORBIDDEN", `Only the person who created this round can ${verb} new entries.`)
  }
  if (round.state === "CLOSED") {
    throw new CardSortError("WRONG_STATE", "This round is closed, so pending entries can no longer be resolved.")
  }
  return { prisma, round }
}

/**
 * Accept a pending entry: create the real Opportunity.
 *
 * The entry is CLAIMED first (a conditional PENDING → ACCEPTED update) and the
 * Opportunity created second, so two clicks racing cannot create two
 * Opportunities: exactly one caller wins the claim. If creation then fails, the
 * claim is released so the facilitator can retry rather than being left with an
 * entry marked accepted that has no Opportunity behind it.
 */
export async function acceptCardSortNewEntry({
  workspaceId,
  roundId,
  userId,
  entryId,
}: {
  workspaceId: string
  roundId: string
  userId: string
  entryId: string
}) {
  const { prisma, round } = await loadFacilitatedRound(roundId, workspaceId, userId, "accept")
  assertOpportunityRound(round)

  const entry = await prisma.cardSortNewEntry.findFirst({ where: { id: entryId, roundId } })
  if (!entry) throw new CardSortError("NOT_FOUND", `New entry not found: ${entryId}`)

  const now = new Date()
  const claim = await prisma.cardSortNewEntry.updateMany({
    where: { id: entryId, roundId, status: "PENDING" },
    data: { status: "ACCEPTED", resolvedById: userId, resolvedAt: now },
  })
  if (claim.count === 0) {
    throw new CardSortError("WRONG_STATE", `That entry is already ${entry.status.toLowerCase()}.`)
  }

  let opportunity: { id: string }
  try {
    opportunity = await createOpportunityWithLinks(prisma, workspaceId, {
      title: entry.title,
      description: entry.description,
    })
  } catch (error) {
    await prisma.cardSortNewEntry.updateMany({
      where: { id: entryId, roundId, status: "ACCEPTED", acceptedObjectId: null },
      data: { status: "PENDING", resolvedById: null, resolvedAt: null },
    })
    if (error instanceof OpportunityCreateError) {
      throw new CardSortError("INVALID_VALUE", error.message)
    }
    throw error
  }

  await prisma.cardSortNewEntry.update({
    where: { id: entryId },
    data: { acceptedObjectId: opportunity.id },
  })

  // The proposer's suggested bucket becomes their ordinary vote — only while the
  // round is OPEN, because proposals are not accepted once it has been revealed.
  // A suggestion that has since fallen out of the factor's options is dropped
  // rather than failing an accept that has already succeeded.
  let suggestionRecorded = false
  if (entry.suggestedValue && round.state === "OPEN") {
    const factor = await loadFactor(prisma, {
      workspaceId,
      fieldDefinitionId: round.fieldDefinitionId,
    })
    if (factor.options.some((option) => option.value === entry.suggestedValue)) {
      await prisma.cardSortProposal.upsert({
        where: {
          roundId_userId_objectId: { roundId, userId: entry.userId, objectId: opportunity.id },
        },
        create: {
          roundId,
          userId: entry.userId,
          objectId: opportunity.id,
          proposedValue: entry.suggestedValue,
          fromValue: null,
          rationale: "Suggested when proposing this entry.",
        },
        update: {},
      })
      suggestionRecorded = true
    }
  }

  return { entryId, opportunityId: opportunity.id, suggestionRecorded }
}

/** Reject a pending entry, optionally saying why. Kept on the round for the record. */
export async function rejectCardSortNewEntry({
  workspaceId,
  roundId,
  userId,
  entryId,
  note,
}: {
  workspaceId: string
  roundId: string
  userId: string
  entryId: string
  note?: string | null
}) {
  const { prisma } = await loadFacilitatedRound(roundId, workspaceId, userId, "reject")
  const cleanNote = trimToNull(note)
  if (cleanNote && cleanNote.length > CARD_SORT_NEW_ENTRY_NOTE_MAX) {
    throw new CardSortError(
      "INVALID_VALUE",
      `Note must be ${CARD_SORT_NEW_ENTRY_NOTE_MAX} characters or fewer.`
    )
  }
  const entry = await prisma.cardSortNewEntry.findFirst({ where: { id: entryId, roundId } })
  if (!entry) throw new CardSortError("NOT_FOUND", `New entry not found: ${entryId}`)

  const claim = await prisma.cardSortNewEntry.updateMany({
    where: { id: entryId, roundId, status: "PENDING" },
    data: {
      status: "REJECTED",
      resolvedById: userId,
      resolvedAt: new Date(),
      resolutionNote: cleanNote,
    },
  })
  if (claim.count === 0) {
    throw new CardSortError("WRONG_STATE", `That entry is already ${entry.status.toLowerCase()}.`)
  }
  return { entryId }
}

/**
 * The entries the caller may see, newest first.
 *
 * The gate decides what is QUERIED, as in loadCardSortBoard: on an OPEN round a
 * participant's query is filtered to their own userId, so other people's entries
 * never leave the database and no serialization mistake downstream can leak
 * them.
 */
export async function listCardSortNewEntries({
  workspaceId,
  roundId,
  userId,
}: {
  workspaceId: string
  roundId: string
  userId: string
}): Promise<CardSortNewEntryView[]> {
  const prisma = getPrisma()
  const round = await loadRound(prisma, roundId, workspaceId)
  if ((round.objectType as CustomFieldObjectType) !== "OPPORTUNITY") return []

  const entries = await prisma.cardSortNewEntry.findMany({
    where: { roundId, ...(canSeeOtherProposals(round, userId) ? {} : { userId }) },
    orderBy: { createdAt: "desc" },
  })
  const proposerIds = [...new Set(entries.map((entry) => entry.userId))]
  const users = proposerIds.length
    ? await prisma.user.findMany({
        where: { id: { in: proposerIds } },
        select: { id: true, name: true, email: true },
      })
    : []
  const label = new Map(users.map((user) => [user.id, user.name || user.email || user.id]))

  return entries.map((entry) => ({
    id: entry.id,
    userId: entry.userId,
    userName: label.get(entry.userId) ?? entry.userId,
    title: entry.title,
    description: entry.description,
    suggestedValue: entry.suggestedValue,
    status: entry.status as CardSortNewEntryStatus,
    acceptedObjectId: entry.acceptedObjectId,
    resolutionNote: entry.resolutionNote,
    resolvedAt: entry.resolvedAt,
    createdAt: entry.createdAt,
    isMine: entry.userId === userId,
  }))
}
