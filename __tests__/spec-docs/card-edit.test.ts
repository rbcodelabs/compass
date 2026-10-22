/** Which embed kinds a card can edit (spec docs phase 4) and that its lists never drift from what the record's own endpoint accepts. */
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/db", () => ({ default: () => ({}) }))

import { CARD_TITLE_MAX_LENGTH, cardEditSpec, validateCardTitle } from "@/lib/spec-docs/card-edit"
import { DOC_EMBED_KINDS } from "@/lib/doc-embeds"
import { EDIT_CONFIG, TASK_STATUSES, TITLE_MAX_LENGTH } from "@/lib/entity-mutations"

describe("cardEditSpec", () => {
  it("offers exactly the kinds with a simple record-page edit, and nothing for the rest", () => {
    const editable = DOC_EMBED_KINDS.filter((kind) => cardEditSpec(kind))
    expect([...editable].sort()).toEqual(["assumption", "experiment", "keyResult", "objective", "opportunity", "solution", "task"])
    for (const kind of ["metric", "doc", "artifact", "roadmapItem"] as const) expect(cardEditSpec(kind)).toBeNull()
  })

  it("status lists equal the server's allowlists (the endpoint is the authority; the card must not offer what it would refuse)", () => {
    for (const kind of ["opportunity", "solution", "assumption", "experiment", "objective", "keyResult"] as const) {
      const spec = cardEditSpec(kind)!
      const server = EDIT_CONFIG[spec.entityType as keyof typeof EDIT_CONFIG]
      expect(server.title).toBe(true)
      if (server.enum?.field === "status") expect([...spec.statuses!]).toEqual([...server.enum.options])
      else expect(spec.statuses).toBeNull()
    }
    expect([...cardEditSpec("task")!.statuses!]).toEqual([...TASK_STATUSES])
  })

  it("the title limit matches the server's", () => {
    expect(CARD_TITLE_MAX_LENGTH).toBe(TITLE_MAX_LENGTH)
  })
})

describe("validateCardTitle", () => {
  it("trims, and rejects empty, whitespace-only and over-long titles without sending", () => {
    expect(validateCardTitle("  Hello  ")).toEqual({ ok: true, title: "Hello" })
    expect(validateCardTitle("")).toMatchObject({ ok: false })
    expect(validateCardTitle("   \n ")).toMatchObject({ ok: false })
    expect(validateCardTitle("x".repeat(CARD_TITLE_MAX_LENGTH))).toMatchObject({ ok: true })
    expect(validateCardTitle("x".repeat(CARD_TITLE_MAX_LENGTH + 1))).toMatchObject({ ok: false })
  })
})
