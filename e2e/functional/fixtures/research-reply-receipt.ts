import { parseResearchChatReply, readResearchChatStream } from "../../../lib/research-chat-stream"

type ReplyResponse = { status(): number; headers(): Record<string, string>; body(): Promise<Buffer> }
type BodyFailureCategory = "body-resource-unavailable" | "body-aborted" | "body-target-closed" | "body-test-ended" | "body-unavailable"
export type ReplyReceiptDiagnostic = { stage: "waiting" | "headers" | "body" | "committed" | "failed"; status: number | null; elapsedMs: number; bytes: number | null; failureCategory?: BodyFailureCategory }

function bodyFailureCategory(error: unknown): BodyFailureCategory {
  // Classify only known instrumentation symptoms; never retain an exception,
  // URL, request data, or provider detail in the test report.
  const message = error instanceof Error ? error.message : ""
  if (message.includes("No resource with given identifier found") || message.includes("No data found for resource with given identifier")) return "body-resource-unavailable"
  if (message.includes("net::ERR_ABORTED")) return "body-aborted"
  if (message.includes("Target closed")) return "body-target-closed"
  if (message.includes("Test ended")) return "body-test-ended"
  return "body-unavailable"
}

/** Test synchronization, not a latency SLA. The enclosing Playwright test keeps its existing deadline. */
export async function awaitResearchReplyReceipt(response: Promise<ReplyResponse>, report: (value: ReplyReceiptDiagnostic) => void) {
  const started = Date.now()
  let status: number | null = null
  let bytes: number | null = null
  let failureCategory: BodyFailureCategory | undefined
  const record = (stage: ReplyReceiptDiagnostic["stage"]) => report({ stage, status, bytes, elapsedMs: Date.now() - started, ...(failureCategory ? { failureCategory } : {}) })
  record("waiting")
  try {
    const received = await response
    status = received.status()
    record("headers")
    if (status !== 200) throw new Error("Unexpected status")
    const body = await received.body().catch(error => {
      failureCategory = bodyFailureCategory(error)
      throw error
    })
    bytes = body.byteLength
    record("body")
    if (bytes > 128 * 1024) throw new Error("Oversized receipt")
    const contentType = received.headers()["content-type"]?.split(";")[0].trim()
    const result = contentType === "application/x-ndjson"
      ? await readResearchChatStream(new Response(new Uint8Array(body)), () => {})
      : contentType === "application/json"
        ? parseResearchChatReply(JSON.parse(body.toString("utf8")))
        : null
    if (!result) throw new Error("Unexpected content type")
    record("committed")
    return result
  } catch {
    record("failed")
    throw new Error("Research reply receipt failed; inspect redacted timing/status diagnostics")
  }
}
