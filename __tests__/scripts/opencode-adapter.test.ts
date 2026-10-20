import { describe, expect, it } from "vitest"
import {
  assistantErrorMessage,
  buildOpencodeConfig,
  finalTextFromParts,
  OpencodeEventMapper,
  opencodeProcessEnv,
  toCompassToolName,
  usageFromMessages,
} from "../../scripts/agent/opencode-adapter"
import { isMutationTool, bareToolName } from "@/lib/agent-mutations"
import { applyAgentSdkEvent, emptyAgentTurnState } from "@/lib/agent-run-stream"

const SECRET_VALUES = ["cmp_supersecret", "vck_gatewaysecret", "bp7x", "run-token-secret", "sk-ant-secret"]

describe("buildOpencodeConfig", () => {
  const config = buildOpencodeConfig({
    model: "anthropic/claude-sonnet-5.5",
    mcpUrl: "https://compass.example.com/api/mcp",
    webSearchUrl: "https://compass.example.com/api/agent/web-search/mcp",
    withBypassHeader: true,
  })

  it("denies every tool by default and allows only the Compass MCP servers", () => {
    const permission = config.permission as Record<string, string>
    expect(permission["*"]).toBe("deny")
    expect(Object.entries(permission).filter(([, action]) => action === "allow").map(([key]) => key).sort()).toEqual(["compass_*", "web_search_*"])
    for (const builtin of ["bash", "edit", "write", "webfetch", "websearch", "task", "read"]) expect(permission[builtin]).toBeUndefined()
  })

  it("registers Compass as a remote MCP server with an env-referenced bearer, no OAuth", () => {
    expect(config.mcp?.compass).toMatchObject({ type: "remote", url: "https://compass.example.com/api/mcp", oauth: false })
    expect((config.mcp?.compass as { headers: Record<string, string> }).headers).toEqual({
      Authorization: "Bearer {env:MCP_TOKEN}",
      "x-vercel-protection-bypass": "{env:MCP_BYPASS_SECRET}",
    })
  })

  it("omits the bypass header and web search when not requested", () => {
    const minimal = buildOpencodeConfig({ model: "m/x", mcpUrl: "https://c/api/mcp" })
    expect((minimal.mcp?.compass as { headers: Record<string, string> }).headers).toEqual({ Authorization: "Bearer {env:MCP_TOKEN}" })
    expect(minimal.mcp?.web_search).toBeUndefined()
    expect(Object.keys(minimal.permission as object)).toEqual(["*", "compass_*"])
  })

  it("pins the gateway provider and disables ambient behaviors", () => {
    expect(config.model).toBe("vercel/anthropic/claude-sonnet-5.5")
    expect(config.enabled_providers).toEqual(["vercel"])
    expect(config).toMatchObject({ share: "disabled", autoupdate: false, snapshot: false, lsp: false, formatter: false, plugin: [], instructions: [] })
  })

  it("contains no secret values: credentials are only {env:...} references", () => {
    const json = JSON.stringify(config)
    for (const secret of SECRET_VALUES) expect(json).not.toContain(secret)
    expect(json).toContain("{env:AI_GATEWAY_API_KEY}")
    expect(json).not.toMatch(/Bearer (?!\{env:)/)
  })

  it("supports the validation-only OpenAI-compatible override without changing the permission posture", () => {
    const mock = buildOpencodeConfig({ model: "m/x", mcpUrl: "https://c/api/mcp", openAiCompatibleBaseUrl: "http://127.0.0.1:1/v1" })
    expect(mock.provider?.vercel).toMatchObject({ npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:1/v1" } })
    expect((mock.permission as Record<string, string>)["*"]).toBe("deny")
  })
})

describe("opencodeProcessEnv", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/real",
    AI_GATEWAY_API_KEY: "vck_gatewaysecret",
    MCP_TOKEN: "cmp_supersecret",
    MCP_BYPASS_SECRET: "bp7x",
    AGENT_RUN_TOKEN: "run-token-secret",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    VERCEL_OIDC_TOKEN: "oidc",
    SOMETHING_ELSE: "x",
  }
  const env = opencodeProcessEnv(source, { configJson: "{}", stateDir: "/tmp/state" })

  it("forwards only the credentials opencode resolves through {env:...}", () => {
    expect(env.AI_GATEWAY_API_KEY).toBe("vck_gatewaysecret")
    expect(env.MCP_TOKEN).toBe("cmp_supersecret")
    expect(env.MCP_BYPASS_SECRET).toBe("bp7x")
  })

  it("never passes the run callback token, the Anthropic key, the OIDC token or unknown vars", () => {
    expect(env).not.toHaveProperty("AGENT_RUN_TOKEN")
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY")
    expect(env).not.toHaveProperty("VERCEL_OIDC_TOKEN")
    expect(env).not.toHaveProperty("SOMETHING_ELSE")
  })

  it("isolates opencode from ambient config, auth, plugins and project files", () => {
    expect(env.HOME).toBe("/tmp/state")
    expect(env.XDG_CONFIG_HOME).toBe("/tmp/state/config")
    expect(env).toMatchObject({
      OPENCODE_CONFIG_CONTENT: "{}",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_PURE: "1",
    })
  })
})

describe("toCompassToolName", () => {
  it("maps opencode MCP tool names to the Claude SDK spelling the audit and UI already understand", () => {
    expect(toCompassToolName("compass_create_opportunity")).toBe("mcp__compass__create_opportunity")
    expect(toCompassToolName("web_search_search")).toBe("mcp__web_search__search")
    expect(toCompassToolName("bash")).toBe("bash")
  })

  it("keeps mutation auditing working end to end", () => {
    const name = toCompassToolName("compass_create_opportunity")
    expect(isMutationTool(name)).toBe(true)
    expect(bareToolName(name)).toBe("create_opportunity")
    expect(isMutationTool(toCompassToolName("compass_list_opportunities"))).toBe(false)
  })
})

describe("OpencodeEventMapper", () => {
  const toolPart = (status: string, extra: object = {}) => ({
    id: "prt_1",
    type: "tool",
    callID: "call_1",
    tool: "compass_get_workspace_summary",
    state: { status, input: { workspaceId: "ws" }, ...extra },
  })

  it("emits a tool_use once when the tool starts and a tool_result once when it completes", () => {
    const mapper = new OpencodeEventMapper()
    expect(mapper.mapPart(toolPart("pending"))).toEqual([])
    const started = mapper.mapPart(toolPart("running"))
    expect(started).toEqual([
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "mcp__compass__get_workspace_summary", input: { workspaceId: "ws" } }] } },
    ])
    expect(mapper.mapPart(toolPart("running"))).toEqual([])
    const done = mapper.mapPart(toolPart("completed", { output: "ok" }))
    expect(done).toEqual([
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok", is_error: false }] } },
    ])
    expect(mapper.mapPart(toolPart("completed", { output: "ok" }))).toEqual([])
  })

  it("emits both blocks if the tool is first seen already completed, and flags errors", () => {
    const mapper = new OpencodeEventMapper()
    const events = mapper.mapPart(toolPart("error", { error: "denied" }))
    expect(events).toHaveLength(2)
    expect(events[1]!.message.content[0]).toMatchObject({ type: "tool_result", content: "denied", is_error: true })
  })

  it("emits text only once finished and skips synthetic or empty text", () => {
    const mapper = new OpencodeEventMapper()
    expect(mapper.mapPart({ id: "t1", type: "text", text: "partial", time: { start: 1 } })).toEqual([])
    expect(mapper.mapPart({ id: "t1", type: "text", text: "final", time: { start: 1, end: 2 } })).toHaveLength(1)
    expect(mapper.mapPart({ id: "t1", type: "text", text: "final", time: { start: 1, end: 2 } })).toEqual([])
    expect(mapper.mapPart({ id: "t2", type: "text", text: "x", synthetic: true, time: { start: 1, end: 2 } })).toEqual([])
    expect(mapper.mapPart({ id: "t3", type: "reasoning", text: "think", time: { start: 1, end: 2 } })).toEqual([])
  })

  it("produces events the existing run-stream reducer understands (harness-agnostic contract)", () => {
    const mapper = new OpencodeEventMapper()
    let state = emptyAgentTurnState
    const wrap = (payload: { type: string }) => ({ type: payload.type, message: payload })
    for (const part of [toolPart("running"), toolPart("completed", { output: "ok" }), { id: "t", type: "text", text: "Done.", time: { start: 1, end: 2 } }]) {
      for (const payload of mapper.mapPart(part)) state = applyAgentSdkEvent(wrap(payload), state)
    }
    expect(state.text).toBe("Done.")
    expect(state.steps).toEqual([expect.objectContaining({ id: "call_1", status: "done" })])
  })
})

describe("results", () => {
  it("joins the final non-synthetic text parts", () => {
    expect(finalTextFromParts([
      { id: "a", type: "tool" },
      { id: "b", type: "text", text: "Hello " },
      { id: "c", type: "text", text: "ignored", synthetic: true },
      { id: "d", type: "text", text: "world\n" },
    ])).toBe("Hello world")
  })

  it("extracts an assistant error message", () => {
    expect(assistantErrorMessage({ id: "m" })).toBeUndefined()
    expect(assistantErrorMessage({ id: "m", error: { name: "ApiError", data: { message: "boom" } } })).toBe("boom")
    expect(assistantErrorMessage({ id: "m", error: { name: "UnknownError" } })).toBe("UnknownError")
  })

  it("sums usage across model calls into the shape the host persists", () => {
    const usage = usageFromMessages(
      [
        { id: "1", tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 1, write: 2 } }, cost: 0.01 },
        { id: "2", tokens: { input: 50, output: 20, cache: { read: 0, write: 0 } }, cost: 0.02 },
      ],
      1234,
    )
    expect(usage).toEqual({
      durationMs: 1234,
      durationApiMs: 1234,
      numTurns: 2,
      totalCostUsd: expect.closeTo(0.03),
      usage: { input_tokens: 150, output_tokens: 35, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 },
    })
  })
})
