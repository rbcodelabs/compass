import { describe, expect, it } from "vitest"
import { extractMentions } from "@/lib/agent-mentions"

const ORIGIN = "https://compass.example.com"
const OPP = "11111111-1111-4111-8111-111111111111"
const SOL = "22222222-2222-4222-8222-222222222222"

const assistant = (content: string) => ({ role: "assistant", content })

describe("extractMentions", () => {
  it("returns newest first and dedupes by target", () => {
    const messages = [
      assistant("See [Opp](/o/w/discovery/" + OPP + ")."),
      { role: "user", content: "[ignored](/o/w/discovery/" + SOL + ")" },
      assistant("Again [Opp](/o/w/discovery/" + OPP + ") and [Sol](/o/w/roadmap?detail=solution:" + SOL + ")"),
    ]
    const out = extractMentions(messages, ORIGIN)
    expect(out.map((m) => (m.kind === "entity" ? m.link.type : m.kind))).toEqual(["solution", "opportunity"])
  })

  it("turns other hosts into external pills and skips non-entity Compass pages", () => {
    const out = extractMentions(
      [assistant("PR: https://github.com/a/b/pull/1. Page: " + ORIGIN + "/o/w/okrs and [x](/o/w/okrs)")],
      ORIGIN,
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: "external", host: "github.com", href: "https://github.com/a/b/pull/1" })
  })

  it("does not double count a markdown link as a bare URL, and respects the limit", () => {
    const out = extractMentions([assistant("[a](https://x.dev/1) [b](https://x.dev/2) [c](https://x.dev/3)")], ORIGIN, 2)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ href: "https://x.dev/3" })
  })

  it("returns nothing for empty threads", () => {
    expect(extractMentions([], ORIGIN)).toEqual([])
  })

  it("picks up display IDs written in prose when a workspace scope is given", () => {
    const scope = { orgSlug: "o", workspaceSlug: "w" }
    const messages = [assistant("Start with TASK-12, then see ART-13. Not a url: https://x.dev/DOC-1")]
    const without = extractMentions(messages, ORIGIN)
    expect(without.filter((m) => m.kind === "entity")).toHaveLength(0)
    const out = extractMentions(messages, ORIGIN, 8, scope)
    const types = out.filter((m) => m.kind === "entity").map((m) => (m.kind === "entity" ? m.link.type + ":" + m.link.id : ""))
    expect(types).toEqual(["artifact:ART-13", "task:TASK-12"])
  })
})
