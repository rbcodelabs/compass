import { probePolicy } from "./protocol"

export async function createProbeCall({ key, offer, runId, signal, onId, onStatus, fetcher = fetch }: { key: string; offer: string; runId: string; signal: AbortSignal; onId(id: string): void; onStatus?(status: number): void; fetcher?: typeof fetch }): Promise<string> {
  const audioOnly = (sdp: string) => Buffer.byteLength(sdp) <= 64 * 1024 &&
    sdp.split(/\r?\n/).filter((line) => line.startsWith("m=")).length === 1 && /^m=audio /m.test(sdp)
  if (!audioOnly(offer) || !/^[A-Za-z0-9_-]{1,64}$/.test(runId)) throw new Error("INVALID_PROBE_OFFER")
  const form = new FormData(); form.set("sdp", offer); form.set("session", JSON.stringify(probePolicy(runId)))
  const response = await fetcher("https://api.openai.com/v1/realtime/calls", {
    method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, redirect: "error", signal,
  })
  if (response.status !== 201) { onStatus?.(response.status); void response.body?.cancel().catch(() => {}); throw new Error("PROVIDER_CREATE_UNRESOLVED") }
  const location = new URL(response.headers.get("location") ?? "", "https://api.openai.com")
  const prefix = "/v1/realtime/calls/"
  const id = location.pathname.slice(prefix.length)
  if (location.origin !== "https://api.openai.com" || !location.pathname.startsWith(prefix) || location.search || location.hash || !/^[A-Za-z0-9_-]{1,255}$/.test(id)) throw new Error("UNTRUSTED_PROVIDER_LOCATION")
  onId(id) // before the body: preserve cleanup identity even if SDP never arrives
  onStatus?.(response.status)
  if (!response.body) throw new Error("PROVIDER_BODY_MISSING")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []; let size = 0
  let abort!: () => void
  const aborted = new Promise<never>((_, reject) => { abort = () => reject(new Error("PROVIDER_BODY_TIMEOUT")); signal.addEventListener("abort", abort, { once: true }) })
  try {
    signal.throwIfAborted()
    while (true) {
      const result = await Promise.race([reader.read(), aborted])
      if (result.done) break
      size += result.value.length
      if (size > 64 * 1024) throw new Error("PROVIDER_BODY_OVERFLOW")
      chunks.push(result.value)
    }
    const answer = Buffer.concat(chunks).toString("utf8")
    if (!audioOnly(answer)) throw new Error("INVALID_PROVIDER_SDP")
    return answer
  } finally { signal.removeEventListener("abort", abort); void reader.cancel().catch(() => {}) }
}
