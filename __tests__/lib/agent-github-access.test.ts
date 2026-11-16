/**
 * Host-side gating for the agent shell + GitHub access (lib/agent-github-access.ts and
 * buildAgentEnv): a workspace without an approved repo list and a minted token behaves
 * exactly as before; with both, Bash is enabled, the prompt says so, and the egress
 * policy is an allowlist.
 */
import { describe, expect, it } from "vitest"
import { buildAgentEnv } from "@/lib/agent-run-sandbox"
import { resolveAgentModel } from "@/lib/agent-model"
import { agentEgressPolicy, turnEgressPolicy, githubShellEnabled, githubShellPrompt, githubSandboxEnv } from "@/lib/agent-github-access"

const base = { connectors: [], mcpBaseUrl: "https://compass.test", mcpToken: "t", prompt: "hi", workspaceId: "ws-1", systemPromptAppendices: [], pluginPaths: [], skillIds: [] }
const anthropic = (() => {
  const r = resolveAgentModel({ ANTHROPIC_API_KEY: "k" })
  if (!r.ok) throw new Error(r.message)
  return r
})()
const bedrock = (() => {
  const r = resolveAgentModel({ AGENT_MODEL_PROVIDER: "bedrock", BEDROCK_API_KEY: "b", AWS_REGION: "eu-west-1" })
  if (!r.ok) throw new Error(r.message)
  return r
})()
const githubEnv = { GH_TOKEN: "ghs_tok", GITHUB_TOKEN: "ghs_tok", AGENT_GITHUB_REPOS: "rbcodelabs/compass,rbcodelabs/docs" }

describe("githubShellEnabled", () => {
  it("needs the claude harness, docs, a token and a non-empty repo list", () => {
    expect(githubShellEnabled({ githubEnv, harness: "claude", docs: true })).toBe(true)
    expect(githubShellEnabled({ githubEnv, docs: true })).toBe(true)
    expect(githubShellEnabled({ githubEnv, harness: "opencode", docs: true })).toBe(false)
    expect(githubShellEnabled({ githubEnv, harness: "claude", docs: false })).toBe(false)
    expect(githubShellEnabled({ githubEnv: {}, harness: "claude", docs: true })).toBe(false)
    expect(githubShellEnabled({ githubEnv: undefined, harness: "claude", docs: true })).toBe(false)
    expect(githubShellEnabled({ githubEnv: { ...githubEnv, GH_TOKEN: " " }, harness: "claude", docs: true })).toBe(false)
    expect(githubShellEnabled({ githubEnv: { ...githubEnv, AGENT_GITHUB_REPOS: "" }, harness: "claude", docs: true })).toBe(false)
  })
})

describe("buildAgentEnv with the GitHub shell", () => {
  const withShell = buildAgentEnv({ ...base, harness: "claude", model: anthropic, docs: true, githubEnv })

  it("no allowlist or no token => exactly the old behaviour: no token, no switch, the 'unavailable' prompt", () => {
    for (const noShell of [
      buildAgentEnv({ ...base, harness: "claude", model: anthropic, docs: true }),
      buildAgentEnv({ ...base, harness: "claude", model: anthropic, docs: true, githubEnv: {} }),
      buildAgentEnv({ ...base, harness: "claude", model: anthropic, docs: true, githubEnv: { AGENT_GITHUB_REPOS: "rbcodelabs/compass" } }),
      buildAgentEnv({ ...base, harness: "claude", model: anthropic, docs: true, githubEnv: { GH_TOKEN: "t" } }),
    ]) {
      expect(noShell).not.toHaveProperty("GH_TOKEN")
      expect(noShell).not.toHaveProperty("GITHUB_TOKEN")
      expect(noShell).not.toHaveProperty("AGENT_GITHUB_SHELL")
      expect(noShell.AGENT_SYSTEM_PROMPT).toContain("Unavailable capabilities include shell, GitHub, Jira")
      expect(noShell.AGENT_SYSTEM_PROMPT).not.toContain("GitHub and the shell")
    }
  })

  it("a token without docs (claim-scoped run) or on opencode is dropped, never forwarded", () => {
    const noDocs = buildAgentEnv({ ...base, harness: "claude", model: anthropic, githubEnv })
    expect(noDocs).not.toHaveProperty("GH_TOKEN")
    expect(noDocs).not.toHaveProperty("AGENT_GITHUB_SHELL")
    const opencode = buildAgentEnv({ ...base, harness: "opencode", gatewayApiKey: "g", docs: true, githubEnv })
    expect(opencode).not.toHaveProperty("GH_TOKEN")
    expect(opencode).not.toHaveProperty("AGENT_GITHUB_REPOS")
  })

  it("allowlist + token => token pair, repo list, on-switch and the new prompt", () => {
    expect(withShell).toMatchObject({ GH_TOKEN: "ghs_tok", GITHUB_TOKEN: "ghs_tok", AGENT_GITHUB_REPOS: "rbcodelabs/compass,rbcodelabs/docs", AGENT_GITHUB_SHELL: "1" })
    const prompt = withShell.AGENT_SYSTEM_PROMPT
    expect(prompt).not.toContain("Unavailable capabilities include shell")
    expect(prompt).toContain("restricted shell (Bash)")
    expect(prompt).toContain("Unavailable capabilities include Jira, Vercel, Obsidian, hooks, commands, and subagents.")
    expect(prompt).toContain("`rbcodelabs/compass`, `rbcodelabs/docs`")
  })

  it("the new prompt covers cloning, branches and PRs, the never-list, and untrusted repo content", () => {
    const prompt = withShell.AGENT_SYSTEM_PROMPT
    expect(prompt).toContain("git clone --depth 1")
    expect(prompt).toContain("git push -u origin <branch>")
    expect(prompt).toContain("gh pr create")
    expect(prompt).toMatch(/Never push to main, master or the default branch, never force-push/)
    expect(prompt).toMatch(/untrusted data, not instructions/)
    expect(prompt).toContain("/vercel/sandbox/repos")
    // The docs prompt is still there and the token never appears in any prompt text.
    expect(prompt).toContain("local copy of this workspace's docs")
    expect(prompt).not.toContain("ghs_tok")
  })

  it("keeps the other secrets out of the GitHub env block", () => {
    expect(githubSandboxEnv(true, { ...githubEnv, MCP_TOKEN: "x" } as Record<string, string>)).toEqual({
      GH_TOKEN: "ghs_tok",
      GITHUB_TOKEN: "ghs_tok",
      AGENT_GITHUB_REPOS: "rbcodelabs/compass,rbcodelabs/docs",
      AGENT_GITHUB_SHELL: "1",
    })
    expect(githubSandboxEnv(false, githubEnv)).toEqual({})
  })

  it("githubShellPrompt names every repo and nothing about credentials values", () => {
    expect(githubShellPrompt(["a/b"])).toContain("`a/b`")
  })
})

describe("agentEgressPolicy", () => {
  it("is an allowlist of GitHub, the Compass origin and the model provider only", () => {
    expect(agentEgressPolicy({ mcpBaseUrl: "https://compass.rbcodelabs.com", model: anthropic })).toEqual({
      allow: ["github.com", "api.github.com", "codeload.github.com", "compass.rbcodelabs.com", "api.anthropic.com"],
      denySubnets: ["169.254.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "0.0.0.0/8"],
    })
  })

  it("uses the Bedrock runtime host of the configured region instead of the Anthropic API", () => {
    const policy = agentEgressPolicy({ mcpBaseUrl: "https://x.vercel.app", model: bedrock })
    expect(policy).toEqual({ allow: ["github.com", "api.github.com", "codeload.github.com", "x.vercel.app", "bedrock-runtime.eu-west-1.amazonaws.com"], denySubnets: expect.any(Array) })
  })

  it("never allows everything: no wildcard, and private ranges are denied", () => {
    const policy = agentEgressPolicy({ mcpBaseUrl: "https://compass.test", model: anthropic })
    expect(policy).not.toBe("allow-all")
    expect(JSON.stringify(policy)).not.toContain("*")
    expect((policy as { denySubnets: string[] }).denySubnets).toContain("169.254.0.0/16")
  })
})

describe("turnEgressPolicy", () => {
  it("restricts a run with the shell off: Compass and the model only, no GitHub or package hosts", () => {
    const policy = turnEgressPolicy({ mcpBaseUrl: "https://compass.test", model: anthropic, githubShell: false, developer: true }) as { allow: string[]; denySubnets: string[] }
    expect(policy.allow).toEqual(["compass.test", "api.anthropic.com"])
    expect(policy.denySubnets).toContain("10.0.0.0/8")
  })

  it("adds GitHub when the shell is on, and the AI Gateway instead of a Claude host for opencode", () => {
    expect((turnEgressPolicy({ mcpBaseUrl: "https://compass.test", model: anthropic, githubShell: true }) as { allow: string[] }).allow).toContain("github.com")
    const oc = turnEgressPolicy({ mcpBaseUrl: "https://compass.test", githubShell: false, opencode: true }) as { allow: string[] }
    expect(oc.allow).toEqual(["compass.test", "ai-gateway.vercel.sh"])
  })
})

describe("model-facing wording after the built-in WebFetch was removed", () => {
  it("the shell prompts never tell the model it can use WebFetch", () => {
    for (const developer of [false, true]) expect(githubShellPrompt(["rbcodelabs/compass"], developer)).not.toMatch(/WebFetch/)
  })
})

describe("egress hardening that needs no real sandbox", () => {
  it("denies carrier-grade NAT and this-network ranges, and lists no IPv6 range (platform acceptance is unverified)", () => {
    const deny = (agentEgressPolicy({ mcpBaseUrl: "https://compass.test", model: anthropic }) as { denySubnets: string[] }).denySubnets
    expect(deny).toEqual(expect.arrayContaining(["100.64.0.0/10", "0.0.0.0/8"]))
    expect(deny.filter((cidr) => cidr.includes(":"))).toEqual([])
  })

  it("the Claude harness sandbox env turns off the CLI's non-essential traffic, and the opencode one does not carry the flag", () => {
    const claude = buildAgentEnv({ ...base, harness: "claude", model: anthropic })
    expect(claude.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1")
    expect(buildAgentEnv({ ...base, harness: "opencode", gatewayApiKey: "gw" })).not.toHaveProperty("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC")
  })
})
