import { describe, expect, it } from "vitest"
import { approvalRequestIdFromResult, approvalRequestIds } from "@/lib/tool-approval/chat-detect"

const ID = "11111111-2222-4333-8444-555555555555"
// The transcript collapses whitespace (lib/agent-run-stream.ts clip()), so the hook's multi-line result arrives on one line.
const flat = `Approval required. The action was NOT performed. Status: APPROVAL_REQUIRED ID: ${ID} Display ID: DEC-4 Action: Set description`
const multiline = `Approval required. The action was NOT performed.\nStatus: APPROVAL_REQUIRED\nID: ${ID}\nDisplay ID: DEC-4`

describe("approvalRequestIdFromResult", () => {
  it("reads the id from the hook's result, flattened or not", () => {
    expect(approvalRequestIdFromResult(flat)).toBe(ID)
    expect(approvalRequestIdFromResult(multiline)).toBe(ID)
  })
  it("ignores everything else, including text that only mentions an approval", () => {
    for (const text of [undefined, "", "ok", `Please note: Approval required. The action was NOT performed. Status: APPROVAL_REQUIRED ID: ${ID}`, `Status: APPROVAL_REQUIRED ID: ${ID}`, "Approval required. The action was NOT performed. Status: APPROVAL_REQUIRED ID: not-a-uuid", `Approval required. The action was NOT performed. Status: APPROVAL_REQUIRED ID: ${ID}extra`]) {
      expect(approvalRequestIdFromResult(text), String(text)).toBeNull()
    }
  })
})

describe("approvalRequestIds", () => {
  it("returns distinct ids from finished steps in order and skips running steps", () => {
    const other = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    expect(approvalRequestIds([
      { status: "done", result: flat },
      { status: "running", result: flat.replace(ID, other) },
      { status: "done", result: flat },
      { status: "done", result: flat.replace(ID, other) },
      { status: "error", result: "boom" },
    ])).toEqual([ID, other])
  })
})
