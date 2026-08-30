function parseTrustedOrigin(raw: string, allowLocalhost: boolean): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error("Compass app URL is invalid.")
  }
  const localhost = allowLocalhost && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)
  if (url.protocol !== "https:" && !localhost) throw new Error("Compass app URL must use HTTPS (except local development).")
  if (url.username || url.password) throw new Error("Compass app URL is invalid.")
  return url
}

function parseVercelOrigin(raw: string): URL {
  const hasScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw)
  return parseTrustedOrigin(hasScheme ? raw : `https://${raw}`, false)
}

function trustedCompassBaseUrl(): URL {
  if (process.env.VERCEL_ENV === "preview") {
    const previewHost = process.env.VERCEL_BRANCH_URL ?? process.env.VERCEL_URL
    if (!previewHost) throw new Error("Compass preview URL is not configured.")
    return parseVercelOrigin(previewHost)
  }

  if (process.env.VERCEL_ENV === "production") {
    if (process.env.NEXT_PUBLIC_APP_URL) return parseTrustedOrigin(process.env.NEXT_PUBLIC_APP_URL, false)
    if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return parseVercelOrigin(process.env.VERCEL_PROJECT_PRODUCTION_URL)
    throw new Error("Compass production URL is not configured.")
  }

  return parseTrustedOrigin(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000", true)
}

export function feedbackItemUrl(input: {
  orgSlug: string
  workspaceSlug: string
  feedbackId: string
}): string {
  const base = trustedCompassBaseUrl()
  const url = new URL(
    `/${encodeURIComponent(input.orgSlug)}/${encodeURIComponent(input.workspaceSlug)}/feedback`,
    base,
  )
  url.searchParams.set("detail", `feedback:${input.feedbackId}`)
  return url.toString()
}

export function researchParticipantUrl(token: string): string {
  return new URL(`/research/${encodeURIComponent(token)}`, trustedCompassBaseUrl()).toString()
}
