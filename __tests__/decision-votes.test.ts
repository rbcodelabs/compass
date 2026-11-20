/**
 * Advisory votes on tracked Decisions (ADR-0030). The fake database honours the workspace filter, the revision filter and the unique key, so a
 * missing scope or a double vote shows up as a real wrong count rather than a mock that returns what the test told it to.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

type Vote = { workspaceId: string; requestId: string; revisionId: string; questionIndex: number; chosenOption: string; voterUserId: string }
const state = vi.hoisted(() => ({
  requests: [] as { id: string; workspaceId: string; state: string; currentRevisionId: string; packetJson: string }[],
  votes: [] as Vote[],
  users: [] as { id: string; name: string | null }[],
  missingTable: false,
  moveOnCount: false,
}))

vi.mock("@/lib/db", () => ({
  default: () => {
  const db = {
    reviewRequest: {
      updateMany: async ({ where }: { where: { id: string; workspaceId: string; state: string; currentRevisionId: string } }) => ({
        count: state.requests.filter(r => r.id === where.id && r.workspaceId === where.workspaceId && r.state === where.state && r.currentRevisionId === where.currentRevisionId).length,
      }),
      findFirst: async ({ where }: { where: { id: string; workspaceId: string } }) => {
        const r = state.requests.find((x) => x.id === where.id && x.workspaceId === where.workspaceId)
        return r ? { id: r.id, state: r.state, currentRevisionId: r.currentRevisionId, currentRevision: { id: r.currentRevisionId, packetJson: r.packetJson } } : null
      },
    },
    decisionVote: {
      findMany: async ({ where, take }: { where: Partial<Vote>; take?: number }) => {
        if (state.missingTable) throw { code: "P2021" }
        if (where.voterUserId === "") throw new Error("invalid UUID")
        return state.votes.filter((v) => Object.entries(where).every(([key, value]) => v[key as keyof Vote] === value)).slice(0, take)
      },
      count: async ({ where }: { where: Partial<Vote> }) => {
        const count = state.votes.filter((v) => Object.entries(where).every(([key, value]) => v[key as keyof Vote] === value)).length
        if (state.moveOnCount) { state.moveOnCount = false; state.votes[0].chosenOption = "Binding" }
        return count
      },
      groupBy: async ({ where }: { where: Partial<Vote> }) => {
        if (state.missingTable) throw { code: "P2021" }
        const grouped = new Map<string, { questionIndex: number; chosenOption: string; _count: { _all: number } }>()
        for (const vote of state.votes.filter((v) => Object.entries(where).every(([key, value]) => v[key as keyof Vote] === value))) {
          const key = JSON.stringify([vote.questionIndex, vote.chosenOption])
          const item = grouped.get(key) ?? { questionIndex: vote.questionIndex, chosenOption: vote.chosenOption, _count: { _all: 0 } }
          item._count._all++
          grouped.set(key, item)
        }
        if (state.moveOnCount) { state.moveOnCount = false; state.votes[0].chosenOption = "Binding" }
        return [...grouped.values()]
      },
      upsert: async ({ where, create, update }: { where: { requestId_revisionId_questionIndex_voterUserId: Omit<Vote, "workspaceId" | "chosenOption"> }; create: Vote; update: { chosenOption: string } }) => {
        const k = where.requestId_revisionId_questionIndex_voterUserId
        const existing = state.votes.find((v) => v.requestId === k.requestId && v.revisionId === k.revisionId && v.questionIndex === k.questionIndex && v.voterUserId === k.voterUserId)
        if (existing) existing.chosenOption = update.chosenOption
        else state.votes.push({ ...create })
      },
      deleteMany: async ({ where }: { where: Omit<Vote, "chosenOption"> }) => {
        state.votes = state.votes.filter((v) => !(v.workspaceId === where.workspaceId && v.requestId === where.requestId && v.revisionId === where.revisionId && v.questionIndex === where.questionIndex && v.voterUserId === where.voterUserId))
      },
    },
    user: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => state.users.filter((u) => where.id.in.includes(u.id)) },
  }
  return { ...db, $transaction: async (work: (tx: typeof db) => Promise<unknown>) => work(db) }
  },
}))

import { castDecisionVote, getDecisionTally, retractDecisionVote, voteQuestionsOf, DecisionVoteError } from "@/lib/decision-votes"

const WS = "aaaaaaaa-0000-4000-8000-00000000000a"
const OTHER_WS = "bbbbbbbb-0000-4000-8000-00000000000b"
const REQ = "cccccccc-0000-4000-8000-00000000000c"
const REV = "dddddddd-0000-4000-8000-00000000000d"
const U1 = "11111111-0000-4000-8000-000000000001"
const U2 = "22222222-0000-4000-8000-000000000002"
const U3 = "33333333-0000-4000-8000-000000000003"

const single = JSON.stringify({ question: "Advisory or binding?", options: [{ label: "Advisory" }, { label: "Binding" }] })
const multi = JSON.stringify({ questions: [{ question: "Weight?", options: [{ label: "Advisory" }, { label: "Binding" }] }, { question: "Names?", options: [{ label: "Named" }, { label: "Anonymous" }] }] })

function seed(packetJson = single, requestState = "PENDING") {
  state.requests = [{ id: REQ, workspaceId: WS, state: requestState, currentRevisionId: REV, packetJson }]
}
const cast = (voterUserId: string, option: string, questionIndex = 0, workspaceId = WS) => castDecisionVote({ workspaceId, requestId: REQ, voterUserId, questionIndex, option, revisionId: REV })
const tally = (viewerUserId = U1, workspaceId = WS) => getDecisionTally({ workspaceId, requestId: REQ, viewerUserId })

beforeEach(() => {
  state.requests = []
  state.votes = []
  state.missingTable = false
  state.moveOnCount = false
  state.users = [{ id: U1, name: "Ada" }, { id: U2, name: "Grace" }, { id: U3, name: null }]
})

describe("voteQuestionsOf", () => {
  it("reads a single-question packet", () => {
    expect(voteQuestionsOf(single)).toEqual([{ question: "Advisory or binding?", options: ["Advisory", "Binding"] }])
  })
  it("reads a multi-question packet", () => {
    expect(voteQuestionsOf(multi).map((q) => q.options)).toEqual([["Advisory", "Binding"], ["Named", "Anonymous"]])
  })
  it("returns nothing for a packet that offers no choices, or garbage", () => {
    expect(voteQuestionsOf(JSON.stringify({ question: "Approve?" }))).toEqual([])
    expect(voteQuestionsOf(JSON.stringify({ question: "Approve?", options: [{ label: "Only one" }] }))).toEqual([])
    expect(voteQuestionsOf("not json")).toEqual([])
    expect(voteQuestionsOf(null)).toEqual([])
  })
})

describe("castDecisionVote", () => {
  it("rejects votes and retractions from a card showing an older revision", async () => {
    seed()
    await cast(U1, "Advisory")
    const oldRevision = REV
    state.requests[0].currentRevisionId = "eeeeeeee-0000-4000-8000-00000000000e"
    await expect(castDecisionVote({ workspaceId: WS, requestId: REQ, voterUserId: U1, questionIndex: 0, option: "Advisory", revisionId: oldRevision } as never)).rejects.toMatchObject({ code: "STALE_REVISION" })
    await expect(retractDecisionVote({ workspaceId: WS, requestId: REQ, voterUserId: U1, questionIndex: 0, revisionId: oldRevision } as never)).rejects.toMatchObject({ code: "STALE_REVISION" })
    expect(state.votes).toHaveLength(1)
  })
  it("records a vote and replaces it when the same person changes their mind", async () => {
    seed()
    await cast(U1, "Advisory")
    await cast(U1, "Binding")
    expect(state.votes).toHaveLength(1)
    expect(state.votes[0].chosenOption).toBe("Binding")
  })

  it("counts one vote per person per question", async () => {
    seed(multi)
    await cast(U1, "Advisory", 0)
    await cast(U1, "Named", 1)
    await cast(U2, "Advisory", 0)
    expect(state.votes).toHaveLength(3)
  })

  it("refuses an option the decision does not offer, and a question that does not exist", async () => {
    seed()
    await expect(cast(U1, "Reject")).rejects.toMatchObject({ code: "INVALID_OPTION" })
    await expect(cast(U1, "Advisory", 3)).rejects.toMatchObject({ code: "INVALID_QUESTION" })
    await expect(cast(U1, "Advisory", -1)).rejects.toMatchObject({ code: "INVALID_QUESTION" })
    expect(state.votes).toHaveLength(0)
  })

  it("refuses once the decision is no longer pending", async () => {
    for (const closed of ["DECIDED", "SUPERSEDED", "EXPIRED", "CANCELLED", "DRAFT"]) {
      seed(single, closed)
      await expect(cast(U1, "Advisory")).rejects.toMatchObject({ code: "CLOSED" })
    }
    expect(state.votes).toHaveLength(0)
  })

  it("treats a decision from another workspace exactly like a missing one", async () => {
    seed()
    await expect(cast(U1, "Advisory", 0, OTHER_WS)).rejects.toBeInstanceOf(DecisionVoteError)
    await expect(cast(U1, "Advisory", 0, OTHER_WS)).rejects.toMatchObject({ code: "NOT_FOUND" })
    state.requests = []
    await expect(cast(U1, "Advisory")).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("never touches the request itself (advisory: no state change)", async () => {
    seed()
    const before = JSON.stringify(state.requests)
    await cast(U1, "Advisory")
    await cast(U2, "Advisory")
    await cast(U3, "Advisory")
    expect(JSON.stringify(state.requests)).toBe(before)
  })
})

describe("getDecisionTally: anonymous until decided", () => {
  it("returns a tally for a service actor without looking up an invalid voter UUID", async () => {
    seed()
    expect((await tally(""))?.questions[0].myVote).toBeNull()
  })

  it("takes one aggregate snapshot when a vote moves between options", async () => {
    seed()
    await cast(U1, "Advisory")
    state.moveOnCount = true
    const t = (await tally(U2))!
    expect(t.questions[0].options.reduce((sum, option) => sum + option.count, 0)).toBe(1)
  })
  it("omits the tally when the vote table has not been migrated", async () => {
    seed()
    state.missingTable = true
    expect(await tally()).toBeNull()
  })

  it("counts all votes and finds the viewer beyond 5000 rows", async () => {
    seed()
    state.votes = Array.from({ length: 5001 }, (_, i) => ({ workspaceId: WS, requestId: REQ, revisionId: REV, questionIndex: 0, chosenOption: "Advisory", voterUserId: i === 5000 ? U1 : `voter-${i}` }))
    const t = (await tally())!
    expect(t.questions[0].options[0].count).toBe(5001)
    expect(t.questions[0].myVote).toBe("Advisory")
  })
  it("shows counts and the own vote of the viewer, but no voters, while pending", async () => {
    seed()
    await cast(U1, "Advisory")
    await cast(U2, "Advisory")
    await cast(U3, "Binding")
    const t = (await tally(U1))!
    expect(t.open).toBe(true)
    expect(t.questions[0].myVote).toBe("Advisory")
    expect(t.questions[0].options).toEqual([{ label: "Advisory", count: 2 }, { label: "Binding", count: 1 }])
    expect(JSON.stringify(t)).not.toMatch(/Ada|Grace|voters|1111|2222|3333/)
  })

  it("does not reveal who voted to someone who did not vote", async () => {
    seed()
    await cast(U1, "Advisory")
    const t = (await tally("99999999-0000-4000-8000-000000000099"))!
    expect(t.questions[0].myVote).toBeNull()
    expect(t.questions[0].options[0].count).toBe(1)
    expect(t.questions[0].options[0]).not.toHaveProperty("voters")
  })

  it("lists voters by display name once decided, and is closed", async () => {
    seed()
    await cast(U1, "Advisory")
    await cast(U3, "Advisory")
    state.requests[0].state = "DECIDED"
    const t = (await tally(U2))!
    expect(t.open).toBe(false)
    expect(t.questions[0].options[0].voters).toEqual(["Ada", "Member"])
    expect(t.questions[0].options[1].voters).toEqual([])
  })

  it("ignores votes cast on an earlier revision", async () => {
    seed()
    await cast(U1, "Advisory")
    state.requests[0].currentRevisionId = "eeeeeeee-0000-4000-8000-00000000000e"
    const t = (await tally(U1))!
    expect(t.questions[0].options.map((o) => o.count)).toEqual([0, 0])
    expect(t.questions[0].myVote).toBeNull()
  })

  it("is null for a missing or foreign decision and for one that offers no choices", async () => {
    seed()
    expect(await tally(U1, OTHER_WS)).toBeNull()
    seed(JSON.stringify({ question: "Approve?" }))
    expect(await tally()).toBeNull()
  })
})

describe("retractDecisionVote", () => {
  it("removes only the own vote and is idempotent", async () => {
    seed()
    await cast(U1, "Advisory")
    await cast(U2, "Advisory")
    await retractDecisionVote({ workspaceId: WS, requestId: REQ, voterUserId: U1, questionIndex: 0, revisionId: REV })
    await retractDecisionVote({ workspaceId: WS, requestId: REQ, voterUserId: U1, questionIndex: 0, revisionId: REV })
    expect(state.votes.map((v) => v.voterUserId)).toEqual([U2])
  })

  it("refuses once decided, so an outcome cannot be altered by editing votes", async () => {
    seed()
    await cast(U1, "Advisory")
    state.requests[0].state = "DECIDED"
    await expect(retractDecisionVote({ workspaceId: WS, requestId: REQ, voterUserId: U1, questionIndex: 0, revisionId: REV })).rejects.toMatchObject({ code: "CLOSED" })
    expect(state.votes).toHaveLength(1)
  })
})
