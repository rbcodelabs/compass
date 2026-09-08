import type { Page } from "@playwright/test"

/** Observe one actual application fetch, never replay it or replace its response.
 * CDP body buffers can be unavailable even when the page consumed the full body.
 * The clone is bounded and still passes through the same strict receipt parser.
 */
export async function observeResearchReply(page: Page) {
  await page.evaluate(() => {
    type Capture = { status: number; contentType: string; bytes: number[] | null }
    const state = window as unknown as { researchReplyObservation?: Promise<Capture> }
    if (state.researchReplyObservation) throw new Error("Reply observer already installed")
    let resolve!: (value: Capture) => void
    state.researchReplyObservation = new Promise<Capture>(done => { resolve = done })
    const original = window.fetch
    window.fetch = function (...args: Parameters<typeof fetch>) {
      const [input, init] = args
      const url = new URL(input instanceof Request ? input.url : String(input), location.href)
      const method = init?.method ?? (input instanceof Request ? input.method : "GET")
      const matches = url.origin === location.origin && url.pathname === "/api/research/respond" && method.toUpperCase() === "POST"
      const request = original.apply(this, args)
      if (matches) {
        window.fetch = original
        void request.then(async response => {
          const status = response.status
          const contentType = response.headers.get("content-type") ?? ""
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
          try {
            reader = response.clone().body?.getReader()
            if (!reader) throw new Error("Missing body")
            const chunks: Uint8Array[] = []
            let length = 0
            while (true) {
              const chunk = await reader.read()
              if (chunk.done) break
              length += chunk.value.byteLength
              if (length > 128 * 1024) throw new Error("Observer limit")
              chunks.push(chunk.value)
            }
            const bytes = new Uint8Array(length)
            let offset = 0
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
            resolve({ status, contentType, bytes: Array.from(bytes) })
          } catch {
            // A tee's cancellation can wait for the application's branch. Do
            // not delay the failure receipt or interfere with that branch.
            void reader?.cancel().catch(() => undefined)
            resolve({ status, contentType, bytes: null })
          } finally { reader?.releaseLock() }
        }, () => resolve({ status: 0, contentType: "", bytes: null }))
      }
      return request
    }
  })
  return async () => {
    const result = await page.evaluate(async () => {
      const state = window as unknown as { researchReplyObservation?: Promise<{ status: number; contentType: string; bytes: number[] | null }> }
      if (!state.researchReplyObservation) throw new Error("Reply observer missing")
      try { return await state.researchReplyObservation } finally { delete state.researchReplyObservation }
    })
    return {
      status: () => result.status,
      headers: () => ({ "content-type": result.contentType }),
      body: async () => {
        if (!result.bytes) throw new Error("Browser reply body unavailable")
        return Buffer.from(result.bytes)
      },
    }
  }
}
