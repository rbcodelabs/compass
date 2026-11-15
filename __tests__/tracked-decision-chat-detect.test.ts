import { describe, expect, it } from "vitest"
import {
  trackedDecisionIdsFromText,
  trackedDecisionRequestIdFromResult,
  trackedDecisionRequestIds,
} from "@/lib/tracked-decision-chat-detect"

const ID_1 = "11111111-2222-4333-8444-555555555555"
const ID_2 = "aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee"

describe("trackedDecisionRequestIdFromResult", () => {
  it("extracts the request UUID from a standard request_decision MCP result", () => {
    const result = `Decision requested.\nID: ${ID_1.toUpperCase()}\nRevision ID: 99999999-0000-4000-8000-111111111111\nOptions: Ship now | Wait\nURL: https://compass.example.com/acme/product/reviews/${ID_1}`
    expect(trackedDecisionRequestIdFromResult(result)).toBe(ID_1)
  })

  it("handles whitespace normalization in streamed tool results", () => {
    expect(trackedDecisionRequestIdFromResult(`  Decision requested.   ID: ${ID_2}  Revision ID: abc`)).toBe(ID_2)
  })

  it("rejects TOOL_APPROVAL outputs and mid-prose mentions so untrusted prose cannot spoof tool cards", () => {
    expect(
      trackedDecisionRequestIdFromResult(
        `Approval required. The action was NOT performed. Status: APPROVAL_REQUIRED ID: ${ID_1}`,
      ),
    ).toBeNull()
    expect(trackedDecisionRequestIdFromResult(`Note: Decision requested. ID: ${ID_1}`)).toBeNull()
    expect(trackedDecisionRequestIdFromResult(undefined)).toBeNull()
  })
})

describe("trackedDecisionRequestIds", () => {
  it("ignores running steps and deduplicates finished step IDs in encounter order", () => {
    expect(
      trackedDecisionRequestIds([
        { status: "running", result: `Decision requested.\nID: ${ID_1}` },
        { status: "done", result: `Decision requested.\nID: ${ID_2}` },
        { status: "done", result: `Decision requested.\nID: ${ID_1}` },
        { status: "done", result: `Decision requested.\nID: ${ID_2}` },
      ]),
    ).toEqual([ID_2, ID_1])
  })
})

describe("trackedDecisionIdsFromText", () => {
  it("extracts same-workspace /reviews/<uuid> and ?detail=review:<uuid> references while ignoring foreign workspaces", () => {
    const markdown = [
      `I raised [this decision](https://compass.rbcodelabs.com/acme/product/reviews/${ID_1}) for review.`,
      `You can also open [the drawer](/acme/product/roadmap?detail=review%3A${ID_2}) or [duplicate](/acme/product/reviews/${ID_1}).`,
      `Foreign workspace link [ignored](/other/ws/reviews/ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb).`,
    ].join("\n")
    expect(trackedDecisionIdsFromText(markdown, "/acme/product")).toEqual([ID_1, ID_2])
  })
})
