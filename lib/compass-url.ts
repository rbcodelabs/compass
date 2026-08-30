function trustedCompassBaseUrl(): URL {
  const configured = process.env.NEXT_PUBLIC_APP_URL
  const vercelProductionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL
  const raw = configured ?? (vercelProductionHost ? `https://${vercelProductionHost}` : "http://localhost:3000")
  const url = new URL(raw)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("Compass app URL must use HTTPS (except localhost).")
  }
  return url
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
