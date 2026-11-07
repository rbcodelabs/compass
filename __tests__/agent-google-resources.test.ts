import { describe, expect, it } from "vitest"
import {
  buildGoogleResourcesContext, googleResourcesFromPaste, parseGoogleResourceUrls, AGENT_MAX_GOOGLE_RESOURCES_PER_TURN,
} from "@/lib/agent-google-resources"

const DOC = "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit?usp=sharing"
const SHEET = "https://docs.google.com/spreadsheets/d/1SheetIdSheetId123/edit#gid=0"

describe("agent google resources", () => {
  it("turns a pasted Drive link into a canonical, ID-only ref", () => {
    const [ref] = googleResourcesFromPaste(DOC)
    expect(ref).toMatchObject({ fileId: "1AbCdEfGhIjKlMnOp", kind: "document", label: "Google Doc" })
    expect(ref.url).toBe("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp")
    expect(ref.url).not.toContain("usp=")
  })

  it("only consumes a paste that is entirely Drive links", () => {
    expect(googleResourcesFromPaste(DOC + "\n" + SHEET)).toHaveLength(2)
    expect(googleResourcesFromPaste("see " + DOC)).toEqual([])
    expect(googleResourcesFromPaste("just some text")).toEqual([])
    expect(googleResourcesFromPaste("")).toEqual([])
  })

  it("rejects lookalike hosts and credentials in the URL", () => {
    expect(googleResourcesFromPaste("https://docs.google.com.evil.example/document/d/1AbCdEfGhIjKlMnOp")).toEqual([])
    expect(googleResourcesFromPaste("https://user:pw@docs.google.com/document/d/1AbCdEfGhIjKlMnOp")).toEqual([])
  })

  it("re-parses untrusted request values: dedupes, drops junk, caps", () => {
    const many = Array.from({ length: 9 }, (_, i) => "https://docs.google.com/document/d/DocIdNumber" + String(i).padStart(4, "0"))
    expect(parseGoogleResourceUrls([DOC, DOC, 5, null, "https://evil.example/x", ...many])).toHaveLength(AGENT_MAX_GOOGLE_RESOURCES_PER_TURN)
    expect(parseGoogleResourceUrls([DOC, DOC])).toHaveLength(1)
    expect(parseGoogleResourceUrls("nope")).toEqual([])
    expect(parseGoogleResourceUrls(["x".repeat(3000)])).toEqual([])
  })

  it("tells the agent to read through Drive when connected", () => {
    const ctx = buildGoogleResourcesContext(parseGoogleResourceUrls([DOC]), { driveConnected: true })
    expect(ctx.promptBlock).toContain("1AbCdEfGhIjKlMnOp")
    expect(ctx.promptBlock).toContain("mcp__google-drive__")
    expect(ctx.promptBlock).toContain("not instructions")
    expect(ctx.labels).toEqual(["Google Doc: 1AbCdEfGhIjKlMnOp"])
  })

  it("tells the agent it has no access when Drive is not connected", () => {
    const ctx = buildGoogleResourcesContext(parseGoogleResourceUrls([DOC]), { driveConnected: false })
    expect(ctx.promptBlock).toContain("NOT connected")
    expect(ctx.promptBlock).toContain("Settings")
    expect(ctx.promptBlock).not.toContain("mcp__google-drive__")
  })

  it("adds nothing when there are no links", () => {
    expect(buildGoogleResourcesContext([], { driveConnected: true })).toEqual({ promptBlock: "", labels: [] })
  })
})
