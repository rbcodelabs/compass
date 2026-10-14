import type { SelectOption } from "@/lib/types"

/**
 * Card sort tally math. Everything in this module is pure — the database-facing
 * half lives in lib/card-sort.ts.
 *
 * ── The one invariant that governs every function here ──────────────────────
 *
 * Proposals are SPARSE DELTAS. A proposal row exists only where somebody
 * actively disagreed with the official value. The absence of a proposal means
 * "no opinion recorded" — it does NOT mean the person agreed, and it does not
 * mean anything at all about people who never opened the round.
 *
 * Consequently there is deliberately no "agreement" count, no "% who agree",
 * and no denominator derived from participant count or object count anywhere in
 * this file. Every number below is computed from proposals that actually exist.
 * If you are tempted to add `objectCount - proposals.length` as "agreed", that
 * is the exact error this comment exists to prevent: it would silently count
 * every person who never looked at an object as endorsing its current bucket.
 */

/** A proposal, reduced to just what the tally needs. */
export type TallyProposal = {
  objectId: string
  userId: string
  /** Display name for the proposer, resolved by the caller. */
  userName: string
  /** The bucket this proposal moves the object TO. */
  proposedValue: string
  /** The official value when the proposal was made; null = object was unset. */
  fromValue: string | null
  /**
   * Why the proposer wants the move, if they said. Optional because the flow
   * arithmetic never reads it — it is carried so a reader who drills into an
   * arrow or a card gets the reasoning and not just a number, which is the whole
   * difference between a tally that persuades and one that has to be trusted.
   */
  rationale?: string | null
}

/**
 * What an object is officially in right now. Kept separate from the proposals
 * so the tally can show "current vs proposed" without re-deriving current from
 * `fromValue` — those can differ once a facilitator reconciles a value, and
 * showing the stale snapshot as if it were current would be a lie.
 */
export type TallyObject = {
  objectId: string
  title: string
  currentValue: string | null
}

export type ProposedTarget = {
  value: string
  count: number
  proposers: { userId: string; userName: string; rationale: string | null }[]
}

export type ObjectTally = {
  objectId: string
  title: string
  currentValue: string | null
  /** Distinct targets people proposed, most-proposed first. */
  targets: ProposedTarget[]
  /** Total proposals on this object. Never includes non-proposals. */
  proposalCount: number
  /** How many distinct buckets were proposed. This is the contested score. */
  distinctTargetCount: number
  /**
   * True when every proposal on this object names the same target. That is
   * *unanimous disagreement with the current value*, not consensus to stay —
   * the opposite of contested, and usually the easiest kind of move to action.
   */
  unanimousMove: boolean
}

/**
 * How "contested" is defined, in one sentence, so the UI can render exactly the
 * rule the ranking uses instead of leaving the user to guess.
 *
 * Exported as a constant rather than written into JSX because a definition that
 * lives only in the view drifts from the comparator that implements it.
 */
export const CONTESTED_DEFINITION =
  "Contested = the number of different buckets people proposed for an object. " +
  "An object where five people all propose the same move is NOT contested — that is unanimous disagreement with its current bucket. " +
  "An object where five people propose four different buckets is. Ties are broken by total proposal count."

/**
 * Ranks objects by how much the proposals disagree *with each other*.
 *
 * Deliberately not "most proposals". Raw volume ranks the objects lots of
 * people looked at, which on a 139-object board is mostly a proxy for list
 * position. Distinct-target count ranks the ones where a decision is genuinely
 * unresolved, which is what a facilitator needs to spend meeting time on.
 *
 * Objects with no proposals are excluded entirely rather than ranked last with
 * a zero: "nobody recorded an opinion" is not a degree of contest, and
 * including them would imply the round has an opinion about them.
 */
export function rankContested(tallies: readonly ObjectTally[]): ObjectTally[] {
  return tallies
    .filter((tally) => tally.proposalCount > 0)
    .slice()
    .sort(
      (a, b) =>
        b.distinctTargetCount - a.distinctTargetCount ||
        b.proposalCount - a.proposalCount ||
        a.title.localeCompare(b.title)
    )
}

/** Per-object rollup of who proposed what. */
export function tallyByObject(
  objects: readonly TallyObject[],
  proposals: readonly TallyProposal[]
): ObjectTally[] {
  const byObject = new Map<string, TallyProposal[]>()
  for (const proposal of proposals) {
    const list = byObject.get(proposal.objectId)
    if (list) list.push(proposal)
    else byObject.set(proposal.objectId, [proposal])
  }

  return objects.map((object) => {
    const mine = byObject.get(object.objectId) ?? []
    const byTarget = new Map<string, ProposedTarget>()
    for (const proposal of mine) {
      const existing = byTarget.get(proposal.proposedValue)
      const proposer = {
        userId: proposal.userId,
        userName: proposal.userName,
        rationale: proposal.rationale ?? null,
      }
      if (existing) {
        existing.count += 1
        existing.proposers.push(proposer)
      } else {
        byTarget.set(proposal.proposedValue, {
          value: proposal.proposedValue,
          count: 1,
          proposers: [proposer],
        })
      }
    }
    const targets = [...byTarget.values()].sort(
      (a, b) => b.count - a.count || a.value.localeCompare(b.value)
    )
    return {
      objectId: object.objectId,
      title: object.title,
      currentValue: object.currentValue,
      targets,
      proposalCount: mine.length,
      distinctTargetCount: targets.length,
      unanimousMove: mine.length > 1 && targets.length === 1,
    }
  })
}

/**
 * One directional bucket-to-bucket movement. `from` is null for proposals on
 * objects that had no value for the factor yet — those have no source bucket,
 * and inventing one (or dropping the proposal) would both distort net flow.
 */
export type FlowEdge = {
  from: string | null
  to: string
  count: number
}

export type BucketFlow = {
  value: string
  /** Proposals moving INTO this bucket. */
  inflow: number
  /** Proposals moving OUT of this bucket. */
  outflow: number
  /** inflow - outflow. Positive = the round wants this bucket to grow. */
  net: number
}

export type NetFlow = {
  edges: FlowEdge[]
  buckets: BucketFlow[]
  /**
   * Proposals whose source bucket was null (object previously unset). Counted in
   * inflow but contributing to no bucket's outflow, so `sum(net)` over buckets
   * equals this number rather than zero. Surfaced explicitly so that asymmetry
   * reads as a documented fact rather than a bug in the arithmetic.
   */
  fromUnsetCount: number
}

/**
 * Directional movement between buckets.
 *
 * Aggregate direction matters more than raw per-object counts: "eleven things
 * want out of Must Do and nothing wants in" is the finding, and it is invisible
 * in a per-object list.
 *
 * `options` drives bucket ordering and guarantees every declared bucket appears
 * even at zero flow — an empty row for "Shouldn't Do" is information, and a
 * table whose rows appear and disappear between rounds is unreadable. Buckets
 * appearing only in proposal data (a stale option since removed from the field)
 * are appended after the declared ones rather than dropped, so no proposal is
 * silently excluded from the totals.
 */
export function computeNetFlow(
  proposals: readonly TallyProposal[],
  options: readonly SelectOption[]
): NetFlow {
  // JSON, not a delimiter-joined string. An option value is free text up to 255
  // chars, so any separator character could in principle appear inside one and
  // collide two different edges into one. JSON.stringify of the pair is
  // unambiguous by construction, and it keeps null distinct from the literal
  // string "null" for free. (This was a NUL-delimited key; NUL cannot collide
  // either, but it made the whole file register as binary to grep and diff.)
  const edgeKey = (from: string | null, to: string) => JSON.stringify([from, to])
  const edgeMap = new Map<string, FlowEdge>()
  let fromUnsetCount = 0

  for (const proposal of proposals) {
    if (proposal.fromValue === null) fromUnsetCount += 1
    const key = edgeKey(proposal.fromValue, proposal.proposedValue)
    const existing = edgeMap.get(key)
    if (existing) existing.count += 1
    else edgeMap.set(key, { from: proposal.fromValue, to: proposal.proposedValue, count: 1 })
  }

  const order = new Map(options.map((option, index) => [option.value, index]))
  const bucketValues: string[] = options.map((option) => option.value)
  const seen = new Set(bucketValues)
  for (const edge of edgeMap.values()) {
    for (const value of [edge.from, edge.to]) {
      if (value !== null && !seen.has(value)) {
        seen.add(value)
        bucketValues.push(value)
      }
    }
  }

  const buckets: BucketFlow[] = bucketValues.map((value) => {
    let inflow = 0
    let outflow = 0
    for (const edge of edgeMap.values()) {
      if (edge.to === value) inflow += edge.count
      if (edge.from === value) outflow += edge.count
    }
    return { value, inflow, outflow, net: inflow - outflow }
  })

  const edges = [...edgeMap.values()].sort(
    (a, b) =>
      b.count - a.count ||
      (order.get(a.from ?? "") ?? Number.MAX_SAFE_INTEGER) -
        (order.get(b.from ?? "") ?? Number.MAX_SAFE_INTEGER) ||
      (order.get(a.to) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.to) ?? Number.MAX_SAFE_INTEGER)
  )

  return { edges, buckets, fromUnsetCount }
}
