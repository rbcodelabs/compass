import { afterEach, expect, it, vi } from "vitest"
import { awaitResearchReplyReceipt } from "../e2e/functional/fixtures/research-reply-receipt"

const committed = { message: "Saved question", turn: { id: "turn", role: "INTERVIEWER", content: "Saved question", sequence: 2 }, replayed: false }
const finalBody = JSON.stringify({ type: "delta", text: "Draft" }) + "\n" + JSON.stringify({ type: "final", result: committed }) + "\n"
function response(body = finalBody, status = 200, contentType = "application/x-ndjson") {
  return { status: () => status, headers: () => ({ "content-type": contentType }), body: async () => Buffer.from(body) }
}
afterEach(() => vi.useRealTimers())

it("waits beyond five seconds for terminal body before allowing the render assertion", async () => {
  vi.useFakeTimers()
  const renderAssertion = vi.fn()
  const report = vi.fn()
  const pending = awaitResearchReplyReceipt(Promise.resolve({ ...response(), body: () => new Promise<Buffer>(resolve => setTimeout(() => resolve(Buffer.from(finalBody)), 6_000)) }), report).then(renderAssertion)
  await vi.advanceTimersByTimeAsync(5_001)
  expect(renderAssertion).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(999)
  await pending
  expect(renderAssertion).toHaveBeenCalledWith(committed)
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ stage: "committed", status: 200, elapsedMs: 6_000 }))
})

it.each([
  [503, "private participant answer", "application/json"],
  [200, '{"type":"error","status":502}\n', "application/x-ndjson"],
  [200, '{"type":"delta","text":"private participant answer"}\n', "application/x-ndjson"],
  [200, '{"message":"private participant answer"}', "application/json"],
])("fails before rendering on HTTP or incomplete receipt %#", async (status, body, contentType) => {
  const report = vi.fn()
  await expect(awaitResearchReplyReceipt(Promise.resolve(response(body, status, contentType)), report)).rejects.toThrow("Research reply receipt failed")
  expect(JSON.stringify(report.mock.calls)).not.toContain("private participant answer")
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ stage: "failed", status }))
})

it("preserves strict JSON compatibility as well as streaming", async () => {
  expect(await awaitResearchReplyReceipt(Promise.resolve(response(JSON.stringify(committed), 200, "application/json")), vi.fn())).toEqual(committed)
})

it("reports an unavailable HTTP response without leaking transport error details", async () => {
  const report = vi.fn()
  await expect(awaitResearchReplyReceipt(Promise.reject(new Error("secret bearer value")), report)).rejects.toThrow("Research reply receipt failed")
  expect(JSON.stringify(report.mock.calls)).not.toContain("secret")
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ status: null, stage: "failed" }))
})
