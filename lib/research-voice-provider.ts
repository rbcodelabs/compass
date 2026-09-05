const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls"

export class OpenAIRealtimeProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly ambiguous: boolean,
    readonly status?: number,
    readonly providerCallId?: string,
  ) {
    super(message)
    this.name = "OpenAIRealtimeProviderError"
  }
}

type Fetcher = typeof fetch

export function validateAudioOnlySdp(sdp: string) {
  if (!sdp || Buffer.byteLength(sdp, "utf8") > 64 * 1024) return false
  const media = sdp.split(/\r?\n/).filter((line) => line.startsWith("m="))
  return media.length === 1 && /^m=audio\s/.test(media[0])
}

function providerCallIdFromLocation(location: string | null): string {
  if (!location) throw new OpenAIRealtimeProviderError("OpenAI omitted the call location", "PROVIDER_LOCATION_MISSING", true)
  let url: URL
  try {
    url = new URL(location, OPENAI_REALTIME_CALLS_URL)
  } catch {
    throw new OpenAIRealtimeProviderError("OpenAI returned an invalid call location", "UNTRUSTED_PROVIDER_LOCATION", true)
  }
  const prefix = "/v1/realtime/calls/"
  const callId = url.pathname.startsWith(prefix) ? decodeURIComponent(url.pathname.slice(prefix.length)) : ""
  if (url.origin !== "https://api.openai.com" || !callId || callId.includes("/")) {
    throw new OpenAIRealtimeProviderError("OpenAI returned an untrusted call location", "UNTRUSTED_PROVIDER_LOCATION", true)
  }
  return callId
}

export function createOpenAIRealtimeProvider({ apiKey, fetcher = fetch }: { apiKey: string; fetcher?: Fetcher }) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured")
  return {
    async createCall({ offerSdp, model }: { offerSdp: string; model: string }) {
      if (!validateAudioOnlySdp(offerSdp)) {
        throw new OpenAIRealtimeProviderError("Realtime SDP must contain exactly one audio media section", "INVALID_AUDIO_SDP", false)
      }
      const form = new FormData()
      form.set("sdp", new Blob([offerSdp], { type: "application/sdp" }), "offer.sdp")
      form.set("session", new Blob([JSON.stringify({ type: "realtime", model })], { type: "application/json" }), "session.json")
      let response: Response
      try {
        response = await fetcher(OPENAI_REALTIME_CALLS_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          signal: AbortSignal.timeout(15_000),
        })
      } catch {
        throw new OpenAIRealtimeProviderError("OpenAI call creation outcome is unknown", "PROVIDER_CREATE_AMBIGUOUS", true)
      }
      if (response.status !== 201) {
        if (response.status >= 500) {
          throw new OpenAIRealtimeProviderError("OpenAI call creation outcome is unknown", "PROVIDER_CREATE_AMBIGUOUS", true, response.status)
        }
        throw new OpenAIRealtimeProviderError("OpenAI rejected the Realtime call", "PROVIDER_CREATE_REJECTED", false, response.status)
      }
      const providerCallId = providerCallIdFromLocation(response.headers.get("location"))
      let answerSdp: string
      try {
        answerSdp = await response.text()
      } catch {
        throw new OpenAIRealtimeProviderError(
          "OpenAI call response could not be read", "PROVIDER_RESPONSE_AMBIGUOUS", true, undefined, providerCallId,
        )
      }
      if (!validateAudioOnlySdp(answerSdp)) {
        throw new OpenAIRealtimeProviderError(
          "OpenAI returned a non-audio-only answer", "INVALID_PROVIDER_AUDIO_SDP", true, undefined, providerCallId,
        )
      }
      return {
        answerSdp,
        providerCallId,
      }
    },
    async hangup(providerCallId: string) {
      let response: Response
      try {
        response = await fetcher(`${OPENAI_REALTIME_CALLS_URL}/${encodeURIComponent(providerCallId)}/hangup`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10_000),
        })
      } catch {
        throw new OpenAIRealtimeProviderError("OpenAI hangup outcome is unknown", "PROVIDER_HANGUP_AMBIGUOUS", true)
      }
      if (!response.ok) {
        throw new OpenAIRealtimeProviderError("OpenAI hangup was not confirmed", "PROVIDER_HANGUP_REJECTED", false, response.status)
      }
      return { definite: true as const }
    },
  }
}
