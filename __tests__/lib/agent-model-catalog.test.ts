import { describe, expect, it, vi } from "vitest"
import {
  agentModelPicker,
  fetchGatewayCatalog,
  filterGatewayCatalog,
  GATEWAY_MODELS_URL,
  loadAgentModelCatalog,
  parseAgentModelWithCatalog,
} from "@/lib/agent-model-catalog"
import { agentModelLabel, parseAgentModel } from "@/lib/agent-models"

const payload = {
  data: [
    { id: "openai/gpt-5", name: "GPT-5", type: "language", tags: ["tool-use", "reasoning"], owned_by: "openai" },
    { id: "anthropic/claude-opus-5", name: "Claude Opus 5", type: "language", tags: ["tool-use"], owned_by: "anthropic" },
    { id: "openai/text-embedding-3", name: "Embedding", type: "embedding", tags: ["tool-use"], owned_by: "openai" },
    { id: "meta/llama-no-tools", name: "Llama", type: "language", tags: ["reasoning"], owned_by: "meta" },
    { id: "bad id with spaces", name: "Bad", type: "language", tags: ["tool-use"], owned_by: "x" },
    { id: "x;rm -rf /", name: "Worse", type: "language", tags: ["tool-use"], owned_by: "x" },
    { name: "no id", type: "language", tags: ["tool-use"] },
    { id: "noprovider-model", name: "Slashless", type: "language", tags: ["tool-use"], owned_by: "x" },
  ],
}
const okFetch = () => vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch
const downFetch = () => vi.fn(() => Promise.reject(new Error("down"))) as unknown as typeof fetch
const opencodeEnv = { AGENT_HARNESS: "opencode" }

describe("filterGatewayCatalog", () => {
  it("keeps only tool-use language models with well-formed provider/model ids, sorted by provider then name", () => {
    const models = filterGatewayCatalog(payload)
    expect(models.map((m) => m.value)).toEqual(["anthropic/claude-opus-5", "openai/gpt-5"])
    expect(models[0]).toEqual({ value: "anthropic/claude-opus-5", label: "Claude Opus 5", provider: "anthropic" })
  })
  it("falls back to the id prefix for the provider and the id for the name", () => {
    const [m] = filterGatewayCatalog({ data: [{ id: "acme/foo", type: "language", tags: ["tool-use"] }] })
    expect(m).toEqual({ value: "acme/foo", label: "acme/foo", provider: "acme" })
  })
  it("returns an empty list for garbage", () => {
    expect(filterGatewayCatalog(null)).toEqual([])
    expect(filterGatewayCatalog({ data: "nope" })).toEqual([])
  })
})

describe("fetchGatewayCatalog", () => {
  it("asks the public endpoint with no credentials, a timeout signal and a one hour revalidate window", async () => {
    const fetchImpl = okFetch()
    const models = await fetchGatewayCatalog(fetchImpl)
    expect(models).toHaveLength(2)
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string, RequestInit & { next?: { revalidate?: number } }]
    expect(url).toBe(GATEWAY_MODELS_URL)
    expect(init.next?.revalidate).toBe(3600)
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.stringify(init.headers ?? {})).not.toMatch(/authorization/i)
  })
  it.each([
    ["a network error", () => Promise.reject(new Error("boom"))],
    ["a non-200 status", () => Promise.resolve(new Response("no", { status: 503 }))],
    ["invalid JSON", () => Promise.resolve(new Response("<html>", { status: 200 }))],
    ["an empty catalog", () => Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }))],
  ])("returns null (never throws) on %s", async (_name, impl) => {
    expect(await fetchGatewayCatalog(vi.fn(impl) as unknown as typeof fetch)).toBeNull()
  })
})

describe("harness gating", () => {
  it("does not even fetch on the claude harness", async () => {
    const fetchImpl = okFetch()
    expect(await loadAgentModelCatalog({}, fetchImpl)).toBeNull()
    expect(await loadAgentModelCatalog({ AGENT_HARNESS: "claude" }, fetchImpl)).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it("loads the catalog on opencode", async () => {
    expect(await loadAgentModelCatalog(opencodeEnv, okFetch())).toHaveLength(2)
  })
})

describe("agentModelPicker", () => {
  it("claude harness: curated list, not searchable, explains why", async () => {
    const picker = await agentModelPicker({}, okFetch())
    expect(picker.searchable).toBe(false)
    expect(picker.models.map((m) => m.value)).toContain("claude-sonnet-5")
    expect(picker.note).toMatch(/Claude harness/i)
  })
  it("opencode harness: curated entries first, then the catalog without duplicates", async () => {
    const picker = await agentModelPicker(opencodeEnv, okFetch())
    expect(picker.searchable).toBe(true)
    const values = picker.models.map((m) => m.value)
    expect(values).toEqual(expect.arrayContaining(["claude-sonnet-5", "anthropic/claude-sonnet-5.5", "openai/gpt-5", "anthropic/claude-opus-5"]))
    expect(new Set(values).size).toBe(values.length)
    expect(picker.models.find((m) => m.value === "openai/gpt-5")?.provider).toBe("openai")
    expect(picker.note).toBeNull()
  })
  it("opencode harness with the gateway down: curated list, not searchable, with a short note", async () => {
    const picker = await agentModelPicker(opencodeEnv, downFetch())
    expect(picker.searchable).toBe(false)
    expect(picker.models.map((m) => m.value)).toContain("claude-sonnet-5")
    expect(picker.note).toMatch(/catalog.*unavailable/i)
  })
})

describe("parseAgentModelWithCatalog", () => {
  it("accepts a catalog id on opencode, re-checked against the fetched catalog", async () => {
    expect(await parseAgentModelWithCatalog(" openai/gpt-5 ", opencodeEnv, okFetch())).toBe("openai/gpt-5")
  })
  it("refuses an id the catalog does not list, and ids that fail the shape rule", async () => {
    await expect(parseAgentModelWithCatalog("openai/made-up", opencodeEnv, okFetch())).rejects.toThrow(/available models/)
    await expect(parseAgentModelWithCatalog("x;rm -rf /", opencodeEnv, okFetch())).rejects.toThrow(/available models/)
  })
  it("refuses a catalog id on the claude harness without fetching", async () => {
    const fetchImpl = okFetch()
    await expect(parseAgentModelWithCatalog("openai/gpt-5", {}, fetchImpl)).rejects.toThrow(/available models/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it("still accepts curated values and blank without touching the network", async () => {
    const fetchImpl = okFetch()
    expect(await parseAgentModelWithCatalog("claude-sonnet-5", opencodeEnv, fetchImpl)).toBe("claude-sonnet-5")
    expect(await parseAgentModelWithCatalog("", opencodeEnv, fetchImpl)).toBeNull()
    expect(await parseAgentModelWithCatalog(null, opencodeEnv, fetchImpl)).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it("with the catalog down only curated values pass", async () => {
    const down = downFetch()
    expect(await parseAgentModelWithCatalog("anthropic/claude-sonnet-5.5", opencodeEnv, down)).toBe("anthropic/claude-sonnet-5.5")
    await expect(parseAgentModelWithCatalog("openai/gpt-5", opencodeEnv, down)).rejects.toThrow(/available models/)
  })
})

describe("compatibility", () => {
  it("parseAgentModel stays strictly curated by default and labels unknown ids by the id", () => {
    expect(() => parseAgentModel("openai/gpt-5", opencodeEnv)).toThrow(/available models/)
    expect(agentModelLabel("openai/gpt-5", opencodeEnv)).toBe("openai/gpt-5")
  })
})
