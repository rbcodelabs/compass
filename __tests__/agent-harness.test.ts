import { describe, expect, it } from "vitest"
import {
  gatewayApiKeyFromEnv,
  resolveGatewayCredential,
  opencodeModel,
  OPENCODE_PINNED_VERSION,
  resolveAgentHarness,
} from "@/lib/agent-harness"
import { SANDBOX_DEPENDENCIES, sandboxPackageJson } from "@/lib/agent-sandbox"
import { OPENCODE_VERSION } from "../scripts/agent/opencode-adapter"

describe("resolveAgentHarness", () => {
  it("defaults to claude", () => {
    expect(resolveAgentHarness(undefined)).toBe("claude")
    expect(resolveAgentHarness(null)).toBe("claude")
    expect(resolveAgentHarness("")).toBe("claude")
  })

  it("selects opencode only for the exact value (case and whitespace tolerant)", () => {
    expect(resolveAgentHarness("opencode")).toBe("opencode")
    expect(resolveAgentHarness(" OpenCode\n")).toBe("opencode")
  })

  it("treats typos and unknown values as claude rather than moving traffic to the experimental harness", () => {
    expect(resolveAgentHarness("opencod")).toBe("claude")
    expect(resolveAgentHarness("true")).toBe("claude")
    expect(resolveAgentHarness("claude")).toBe("claude")
  })
})

describe("opencode in the golden snapshot", () => {
  it("pins the same exact version in the adapter and in both snapshot packages", () => {
    expect(OPENCODE_PINNED_VERSION).toBe(OPENCODE_VERSION)
    expect(OPENCODE_PINNED_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    expect(SANDBOX_DEPENDENCIES["opencode-ai"]).toBe(OPENCODE_PINNED_VERSION)
    expect(SANDBOX_DEPENDENCIES["@opencode-ai/sdk"]).toBe(OPENCODE_PINNED_VERSION)
  })

  it("is installed by the snapshot build's package.json, so the fingerprint covers it", () => {
    const pkg = JSON.parse(sandboxPackageJson())
    expect(pkg.dependencies["opencode-ai"]).toBe(OPENCODE_PINNED_VERSION)
    expect(pkg.dependencies["@opencode-ai/sdk"]).toBe(OPENCODE_PINNED_VERSION)
  })
})

describe("credentials and model", () => {
  it("reads only AI_GATEWAY_API_KEY, trimmed, and ignores blank values and the OIDC token", () => {
    expect(gatewayApiKeyFromEnv({ AI_GATEWAY_API_KEY: " vck_x \n" })).toBe("vck_x")
    expect(gatewayApiKeyFromEnv({ AI_GATEWAY_API_KEY: "   " })).toBeUndefined()
    expect(gatewayApiKeyFromEnv({ VERCEL_OIDC_TOKEN: "oidc" })).toBeUndefined()
  })

  it("defaults the model and honors an override", () => {
    expect(opencodeModel(undefined)).toBe("anthropic/claude-sonnet-5.5")
    expect(opencodeModel("openai/gpt-5")).toBe("openai/gpt-5")
  })
})

describe("resolveGatewayCredential", () => {
  it("prefers an explicit key", async () => {
    expect(await resolveGatewayCredential({ AI_GATEWAY_API_KEY: "k" }, async () => "oidc")).toBe("k")
  })
  it("falls back to the deployment OIDC token", async () => {
    expect(await resolveGatewayCredential({}, async () => " oidc ")).toBe("oidc")
  })
  it("returns undefined when OIDC is unavailable", async () => {
    expect(await resolveGatewayCredential({}, async () => { throw new Error("no oidc") })).toBeUndefined()
  })
})
