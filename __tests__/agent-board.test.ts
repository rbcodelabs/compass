/**
 * The agent board's bucketing: which column a conversation lands in, how a column is
 * ordered, and which columns are shown. Pure, so no database is involved.
 */
import { describe, expect, it } from "vitest"

import {
  applyAgentBoardPatch,
  BOARD_COLUMN_LABELS,
  bucketizeBoard,
  bucketizeBoardBySquad,
  classifyBoardCard,
  diffAgentBoardCards,
  filterBoardCards,
  formatRelativeTime,
  formatWakeupCountdown,
  isRunHeartbeatStale,
  STALE_HEARTBEAT_MS,
  type AgentBoardCard,
} from "@/lib/agent-board"

const T0 = "2026-10-05T12:00:00.000Z"
const T1 = "2026-10-05T12:05:00.000Z"
const T2 = "2026-10-05T12:10:00.000Z"

function card(overrides: Partial<AgentBoardCard> = {}): AgentBoardCard {
  return {
    id: "c-1",
    title: "A chat",
    messageCount: 2,
    runStatus: "SUCCEEDED",
    lastActivityAt: T1,
    reviewedAt: null,
    ...overrides,
  }
}

describe("classifyBoardCard", () => {
  it.each(["QUEUED", "RUNNING"])("puts a %s run in Working", (runStatus) => {
    expect(classifyBoardCard(card({ runStatus }))).toBe("working")
  })

  it.each(["FAILED", "INTERRUPTED"])("puts a %s run in Failed", (runStatus) => {
    expect(classifyBoardCard(card({ runStatus }))).toBe("failed")
  })

  it("keeps a failed run in Failed even if the user has reviewed it (a new turn is what clears it)", () => {
    expect(classifyBoardCard(card({ runStatus: "FAILED", reviewedAt: T2 }))).toBe("failed")
  })

  it("lets a running run outrank everything else, including an old review", () => {
    expect(classifyBoardCard(card({ runStatus: "RUNNING", reviewedAt: T2 }))).toBe("working")
  })

  it.each(["SUCCEEDED", "CANCELED", null])("treats a %s latest run as idle", (runStatus) => {
    expect(classifyBoardCard(card({ runStatus }))).toBe("new")
  })

  it("is New when idle with messages and never reviewed", () => {
    expect(classifyBoardCard(card({ reviewedAt: null }))).toBe("new")
  })

  it("is Done when reviewed after the last activity", () => {
    expect(classifyBoardCard(card({ lastActivityAt: T1, reviewedAt: T2 }))).toBe("done")
  })

  it("is Done when reviewed at exactly the last activity instant", () => {
    expect(classifyBoardCard(card({ lastActivityAt: T1, reviewedAt: T1 }))).toBe("done")
  })

  it("becomes New again when activity lands after the review", () => {
    expect(classifyBoardCard(card({ lastActivityAt: T2, reviewedAt: T1 }))).toBe("new")
  })

  it("is Ready when there are no messages, whatever the review says", () => {
    expect(classifyBoardCard(card({ messageCount: 0, runStatus: null, reviewedAt: T2 }))).toBe("ready")
  })

  it("treats an unparseable timestamp as unreviewed rather than throwing", () => {
    expect(classifyBoardCard(card({ reviewedAt: "not-a-date" }))).toBe("new")
  })

  it("puts hold-open RUNNING AWAITING_QUESTION or deadline-parked pendingQuestions in Awaiting", () => {
    expect(classifyBoardCard(card({ runStatus: "RUNNING", substatus: "AWAITING_QUESTION" }))).toBe("awaiting")
    expect(
      classifyBoardCard(
        card({
          runStatus: "INTERRUPTED",
          pendingQuestions: [
            {
              id: "q-1",
              runId: "r-1",
              header: "Scope",
              question: "Which tier?",
              options: [{ label: "Tier 1" }],
              multiSelect: false,
              allowOther: true,
              status: "PENDING",
              answerText: null,
              createdAt: T1,
            },
          ],
        }),
      ),
    ).toBe("awaiting")
  })

  it("puts an idle conversation with a scheduledWakeup in Waiting, while an active run stays in Working", () => {
    const wakeup = {
      id: "w-1",
      fireAt: "2026-10-05T12:15:00.000Z",
      delaySeconds: 300,
      reason: "CI build check",
      prompt: "Check CI status",
    }
    expect(classifyBoardCard(card({ runStatus: "SUCCEEDED", scheduledWakeup: wakeup }))).toBe("waiting")
    expect(classifyBoardCard(card({ runStatus: "RUNNING", scheduledWakeup: wakeup }))).toBe("working")
  })
})

describe("bucketizeBoard", () => {
  it("always shows Working and New, even when empty, and hides every other empty column", () => {
    const columns = bucketizeBoard([])
    expect(columns.map((c) => c.id)).toEqual(["working", "new"])
    expect(columns.every((c) => c.cards.length === 0)).toBe(true)
  })

  it("shows a non-core column only once it has a card, in Geode's column order", () => {
    const columns = bucketizeBoard([
      card({ id: "ready", messageCount: 0, runStatus: null }),
      card({ id: "failed", runStatus: "FAILED" }),
      card({ id: "done", reviewedAt: T2 }),
    ])
    expect(columns.map((c) => c.id)).toEqual(["working", "new", "done", "failed", "ready"])
    expect(columns.map((c) => c.label)).toEqual(["Working", "New", "Done", "Failed", "Ready"])
  })

  it("sorts each column most-recent activity first", () => {
    const columns = bucketizeBoard([
      card({ id: "old", lastActivityAt: T0 }),
      card({ id: "newest", lastActivityAt: T2 }),
      card({ id: "mid", lastActivityAt: T1 }),
    ])
    expect(columns.find((c) => c.id === "new")?.cards.map((c) => c.id)).toEqual(["newest", "mid", "old"])
  })

  it("does not mutate the input array", () => {
    const input = [card({ id: "a", lastActivityAt: T0 }), card({ id: "b", lastActivityAt: T2 })]
    bucketizeBoard(input)
    expect(input.map((c) => c.id)).toEqual(["a", "b"])
  })

  it("exposes a label for every column id", () => {
    expect(Object.keys(BOARD_COLUMN_LABELS).sort()).toEqual([
      "awaiting",
      "done",
      "failed",
      "new",
      "ready",
      "waiting",
      "working",
    ])
  })
})

describe("formatWakeupCountdown", () => {
  const now = Date.parse("2026-10-05T12:00:00.000Z")
  it("formats seconds, minutes, and hours cleanly", () => {
    expect(formatWakeupCountdown("2026-10-05T11:59:55.000Z", now)).toBe("due now")
    expect(formatWakeupCountdown("2026-10-05T12:00:40.000Z", now)).toBe("<1m")
    expect(formatWakeupCountdown("2026-10-05T12:03:00.000Z", now)).toBe("3m")
    expect(formatWakeupCountdown("2026-10-05T13:15:00.000Z", now)).toBe("1h 15m")
    expect(formatWakeupCountdown("2026-10-05T14:00:00.000Z", now)).toBe("2h")
  })
})

describe("formatRelativeTime", () => {
  const now = Date.parse(T2)
  it.each([
    [T2, "just now"],
    ["2026-10-05T12:09:10.000Z", "just now"],
    ["2026-10-05T12:05:00.000Z", "5m ago"],
    ["2026-10-05T09:10:00.000Z", "3h ago"],
    ["2026-10-02T12:10:00.000Z", "3d ago"],
  ])("formats %s as %s", (iso, expected) => {
    expect(formatRelativeTime(iso, now)).toBe(expected)
  })

  it("never shows a negative age for a timestamp slightly in the future (clock skew)", () => {
    expect(formatRelativeTime("2026-10-05T12:10:30.000Z", now)).toBe("just now")
  })
})

describe("isRunHeartbeatStale", () => {
  const now = Date.parse(T2)

  it("flags only RUNNING cards whose heartbeat exceeds STALE_HEARTBEAT_MS", () => {
    const freshIso = new Date(now - STALE_HEARTBEAT_MS + 1_000).toISOString()
    const staleIso = new Date(now - STALE_HEARTBEAT_MS - 1_000).toISOString()

    expect(isRunHeartbeatStale(card({ runStatus: "RUNNING", lastHeartbeatAt: freshIso }), now)).toBe(false)
    expect(isRunHeartbeatStale(card({ runStatus: "RUNNING", lastHeartbeatAt: staleIso }), now)).toBe(true)
    expect(isRunHeartbeatStale(card({ runStatus: "SUCCEEDED", lastHeartbeatAt: staleIso }), now)).toBe(false)
    expect(isRunHeartbeatStale(card({ runStatus: "RUNNING", lastHeartbeatAt: null }), now)).toBe(false)
  })
})

describe("filterBoardCards and bucketizeBoardBySquad", () => {
  const squadA = { id: "sq-1", name: "Platform", color: "#3b82f6" }
  const squadB = { id: "sq-2", name: "Growth", color: "#10b981" }

  const sample: AgentBoardCard[] = [
    card({
      id: "c-platform",
      title: "Migrate links",
      squad: squadA,
      currentActivity: "Running vitest suite",
      subtasks: { completed: 1, total: 2, items: [{ id: "t-1", title: "Audit entity_links", status: "completed" }] },
    }),
    card({
      id: "c-unassigned",
      title: "Triage portal feedback",
      summary: "Clustered 14 enterprise SSO requests",
      prUrl: "https://github.com/rbcodelabs/compass/pull/571",
      linkedObjects: [{ entityType: "OPPORTUNITY", entityId: "o-1", title: "Enterprise SSO", kind: "CREATED" }],
    }),
  ]

  it("matches across title, summary, live activity, squad, PR URL/badge, subtasks, and linked objects", () => {
    expect(filterBoardCards(sample, "vitest").map((c) => c.id)).toEqual(["c-platform"])
    expect(filterBoardCards(sample, "entity_links").map((c) => c.id)).toEqual(["c-platform"])
    expect(filterBoardCards(sample, "platform").map((c) => c.id)).toEqual(["c-platform"])
    expect(filterBoardCards(sample, "enterprise sso").map((c) => c.id)).toEqual(["c-unassigned"])
    expect(filterBoardCards(sample, "pull/571").map((c) => c.id)).toEqual(["c-unassigned"])
    expect(filterBoardCards(sample, "#571").map((c) => c.id)).toEqual(["c-unassigned"])
    expect(filterBoardCards(sample, "PR #571").map((c) => c.id)).toEqual(["c-unassigned"])
    expect(filterBoardCards(sample, "   ").map((c) => c.id)).toEqual(["c-platform", "c-unassigned"])
  })

  it("buckets cards by workspace squads plus No squad sorted newest-activity-first", () => {
    const cols = bucketizeBoardBySquad(sample, [squadA, squadB])
    expect(cols.map((c) => [c.id, c.label, c.cards.length])).toEqual([
      ["sq-1", "Platform", 1],
      ["sq-2", "Growth", 0],
      ["unassigned", "No squad", 1],
    ])
  })
})

describe("diffAgentBoardCards and applyAgentBoardPatch", () => {
  it("emits only changed/removed cards and preserves object identity for untouched cards", () => {
    const a = card({ id: "a", title: "Alpha" })
    const b = card({ id: "b", title: "Beta", runStatus: "RUNNING", currentActivity: "Step 1" })
    const initial = diffAgentBoardCards(new Map(), [a, b])
    expect(initial.upserts).toHaveLength(2)
    expect(initial.removedIds).toEqual([])

    const bUpdated = { ...b, currentActivity: "Step 2" }
    const step2 = diffAgentBoardCards(initial.nextFingerprints, [a, bUpdated])
    expect(step2.upserts).toEqual([bUpdated])
    expect(step2.removedIds).toEqual([])

    const reduced = applyAgentBoardPatch([a, b], { upserts: step2.upserts, removedIds: step2.removedIds })
    expect(reduced[0]).toBe(a) // untouched card keeps exact reference
    expect(reduced[1]).toBe(bUpdated)

    const removed = diffAgentBoardCards(step2.nextFingerprints, [a])
    expect(removed.removedIds).toEqual(["b"])
    expect(applyAgentBoardPatch(reduced, { upserts: [], removedIds: ["b"] })).toEqual([a])
  })
})
