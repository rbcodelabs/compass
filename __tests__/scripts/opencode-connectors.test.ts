import { describe, expect, it } from "vitest"
import {
  buildOpencodeConfig,
  connectorSystemPromptSection,
  OpencodeEventMapper,
  parseConnectors,
  toCompassToolName,
} from "../../scripts/agent/opencode-adapter"
import { isMutationTool } from "@/lib/agent-mutations"

const base = { model: "m/x", mcpUrl: "https://compass.example.com/api/mcp", webSearchUrl: "https://compass.example.com/api/agent/web-search/mcp", withBypassHeader: true }

describe("parseConnectors", () => {
  it("accepts well-formed entries and caps guidance", () => {
    const refs = parseConnectors(JSON.stringify([{ slug: "v0", displayName: "v0", guidance: ` ${"g".repeat(5000)} ` }, { slug: "google-drive" }]))
    expect(refs.map((r) => r.slug)).toEqual(["v0", "google-drive"])
    expect(refs[0]!.guidance).toHaveLength(2000)
    expect(refs[1]!.displayName).toBe("google-drive")
  })

  it("drops bad JSON, non-arrays, bad slugs, reserved names and duplicates without throwing", () => {
    const notes: string[] = []
    expect(parseConnectors("{", (m) => notes.push(m))).toEqual([])
    expect(parseConnectors("{}", (m) => notes.push(m))).toEqual([])
    const refs = parseConnectors(
      JSON.stringify([{ slug: "Bad_Slug" }, { slug: "compass" }, { slug: "web_search" }, { slug: "../x" }, { slug: "ok" }, { slug: "ok" }, null]),
      (m) => notes.push(m),
    )
    expect(refs.map((r) => r.slug)).toEqual(["ok"])
    expect(notes.length).toBeGreaterThan(3)
    expect(parseConnectors(undefined)).toEqual([])
  })

  it("renders guidance only for connectors that have it", () => {
    expect(connectorSystemPromptSection([{ slug: "a", displayName: "A" }])).toBe("")
    expect(connectorSystemPromptSection([{ slug: "a", displayName: "A", guidance: "read-only" }])).toContain("A: read-only")
  })
})

describe("buildOpencodeConfig with connectors", () => {
  const config = buildOpencodeConfig({ ...base, connectors: [{ slug: "v0", displayName: "v0" }, { slug: "google-drive", displayName: "Drive" }] })

  it("registers each connector as a remote server behind the Compass gateway path with the turn credential", () => {
    expect(config.mcp?.v0).toMatchObject({ type: "remote", url: "https://compass.example.com/api/integrations/mcp/v0", oauth: false })
    expect((config.mcp?.["google-drive"] as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer {env:MCP_TOKEN}")
  })

  it("allows only those servers' tools; everything else stays denied", () => {
    const permission = config.permission as Record<string, string>
    expect(permission["*"]).toBe("deny")
    expect(Object.entries(permission).filter(([, v]) => v === "allow").map(([k]) => k).sort()).toEqual(["compass_*", "google-drive_*", "v0_*", "web_search_*"])
    for (const builtin of ["bash", "edit", "write", "webfetch", "task", "skill"]) expect(permission[builtin]).toBeUndefined()
  })

  it("cannot be widened by a hostile slug: unusable and reserved slugs never reach the config", () => {
    const hostile = buildOpencodeConfig({
      ...base,
      connectors: [{ slug: "*", displayName: "x" }, { slug: "compass", displayName: "x" }, { slug: "a b", displayName: "x" }, { slug: "../../admin", displayName: "x" }],
    })
    expect(Object.keys(hostile.mcp ?? {}).sort()).toEqual(["compass", "web_search"])
    expect(Object.keys(hostile.permission as object)).toEqual(["*", "compass_*", "web_search_*"])
    expect((hostile.mcp?.compass as { url: string }).url).toBe(base.mcpUrl)
  })

  it("still contains no secret values", () => {
    const json = JSON.stringify(config)
    for (const secret of ["cmp_secret", "vck_secret", "bypass-secret"]) expect(json).not.toContain(secret)
    expect(json).not.toMatch(/Bearer (?!\{env:)/)
  })
})

describe("connector tool names", () => {
  it("maps connector tools to the Claude SDK spelling so the UI and audit understand them", () => {
    expect(toCompassToolName("google-drive_create_file", ["google-drive"])).toBe("mcp__google-drive__create_file")
    expect(toCompassToolName("google-drive_create_file")).toBe("google-drive_create_file")
    expect(isMutationTool(toCompassToolName("v0_create_chat", ["v0"]))).toBeDefined()
  })

  it("the mapper applies connector slugs", () => {
    const mapper = new OpencodeEventMapper(["v0"])
    const [event] = mapper.mapPart({ id: "p", type: "tool", callID: "c", tool: "v0_create_chat", state: { status: "running", input: {} } })
    expect((event!.message.content[0] as { name: string }).name).toBe("mcp__v0__create_chat")
  })
})
