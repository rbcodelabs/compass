import { describe, expect, it } from "vitest"
import { CONNECTOR_DEFINITIONS } from "@/lib/mcp-connectors/config"

describe("Vercel connector definition", () => {
  const vercel = CONNECTOR_DEFINITIONS.find((d) => d.slug === "vercel")

  it("is registered against Vercel's hosted MCP server over HTTPS", () => {
    expect(vercel?.serverUrl).toBe("https://mcp.vercel.com")
    expect(vercel?.displayName).toBe("Vercel")
    expect(vercel?.fallbackScope).toBe("openid")
  })

  it("holds its grant in Vercel Connect, not via dynamic registration", () => {
    expect(vercel?.tokenSource).toEqual({ kind: "vercel-connect", uidEnv: "COMPASS_VERCEL_CONNECTOR" })
  })

  it("carries no agent guidance and has unique slug", () => {
    expect(vercel?.agentGuidance).toBeUndefined()
    const slugs = CONNECTOR_DEFINITIONS.map((d) => d.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })
})
