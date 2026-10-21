import { describe, expect, it } from "vitest"
import {
  bodySegments,
  mentionRoles,
  parseMentions,
  plainTextOf,
  serializeMention,
  suggestTaskTitle,
  uniqueMentions,
} from "@/lib/comment-mentions"

const QUINN = "6f1c2a40-1111-4222-8333-944455556666"
const QUENTIN = "7a1c2a40-1111-4222-8333-944455556667"
const BOT = "8b1c2a40-1111-4222-8333-944455556668"

const quinn = serializeMention({ kind: "user", id: QUINN, label: "Quinn Morales" })
const quentin = serializeMention({ kind: "user", id: QUENTIN, label: "Quentin Okafor" })
const bot = serializeMention({ kind: "agent", id: BOT, label: "QA Agent" })

describe("comment mention tokens", () => {
  it("round-trips a mention through serialize and parse", () => {
    const body = `Can you draft this? ${quinn}`
    expect(parseMentions(body)).toEqual([
      { kind: "user", id: QUINN, label: "Quinn Morales", start: 20, end: body.length },
    ])
  })

  it("strips characters that would break the token out of a label", () => {
    const token = serializeMention({ kind: "user", id: QUINN, label: "Evil ](mention:agent:x) [Name]" })
    const [match] = parseMentions(`hi ${token}`)
    expect(match.kind).toBe("user")
    expect(match.id).toBe(QUINN)
    expect(match.label).not.toMatch(/[\[\]()]/)
  })

  it("does not treat plain @text or malformed tokens as mentions", () => {
    expect(parseMentions("ping @quinn and @[Quinn](mention:user:not-a-uuid) and @[x](mention:team:" + QUINN + ")")).toEqual([])
  })

  it("normalizes ids to lowercase so one person never appears twice", () => {
    const upper = `@[Quinn](mention:user:${QUINN.toUpperCase()})`
    expect(uniqueMentions(`${quinn} ${upper}`)).toHaveLength(1)
  })

  it("keeps a user and an agent with the same uuid distinct", () => {
    const asAgent = serializeMention({ kind: "agent", id: QUINN, label: "Quinn Bot" })
    expect(uniqueMentions(`${quinn} ${asAgent}`).map(m => m.kind)).toEqual(["user", "agent"])
  })
})

describe("mentionRoles", () => {
  it("makes the first mention the assignee and the rest watchers", () => {
    const roles = mentionRoles(`Drafting with ${quinn} and ${quentin}, review by ${bot}`)
    expect(roles.assignee).toMatchObject({ kind: "user", id: QUINN })
    expect(roles.watchers.map(w => w.id)).toEqual([QUENTIN, BOT])
  })

  it("ignores repeats of the assignee when assigning watchers", () => {
    const roles = mentionRoles(`${quinn} please, ${quinn} again, cc ${quentin}`)
    expect(roles.assignee?.id).toBe(QUINN)
    expect(roles.watchers.map(w => w.id)).toEqual([QUENTIN])
  })

  it("has no assignee when nobody is mentioned", () => {
    expect(mentionRoles("just a note")).toEqual({ assignee: null, watchers: [] })
  })
})

describe("rendering helpers", () => {
  it("splits a body into ordered text and mention segments", () => {
    const segments = bodySegments(`a ${quinn} b`)
    expect(segments.map(s => s.type)).toEqual(["text", "mention", "text"])
  })

  it("renders live names when a resolver is provided, falling back to the snapshot", () => {
    expect(plainTextOf(`hi ${quinn}`)).toBe("hi @Quinn Morales")
    expect(plainTextOf(`hi ${quinn}`, ref => (ref.id === QUINN ? "Quinn M. Renamed" : undefined))).toBe("hi @Quinn M. Renamed")
    expect(plainTextOf(`hi ${bot}`, () => undefined)).toBe("hi @QA Agent")
  })
})

describe("suggestTaskTitle", () => {
  it("drops mention chips and trailing punctuation", () => {
    expect(suggestTaskTitle(`Can you draft this by Friday? ${quinn}`)).toBe("Can you draft this by Friday")
  })

  it("caps long titles", () => {
    const title = suggestTaskTitle("word ".repeat(80))
    expect(title.length).toBeLessThanOrEqual(120)
    expect(title.endsWith("…")).toBe(true)
  })

  it("falls back to the anchored passage when the comment is only mentions", () => {
    expect(suggestTaskTitle(quinn, "The rollout checklist")).toBe("Follow up: The rollout checklist")
    expect(suggestTaskTitle(quinn, null)).toBe("Follow up on comment")
  })
})
