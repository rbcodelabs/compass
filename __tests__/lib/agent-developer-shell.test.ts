/**
 * The DEVELOPER-class shell: what the model is told, which hosts it may reach, and how the npm token travels. The STANDARD
 * class must be byte-for-byte what it was (no servers, no registry, no token).
 */
import { describe, expect, it } from "vitest"
import { buildAgentEnv } from "@/lib/agent-run-sandbox"
import { resolveAgentModel } from "@/lib/agent-model"
import { agentEgressPolicy, developerNpmToken, developerSandboxEnv, githubShellPrompt } from "@/lib/agent-github-access"
import { buildJailedCommand, prepareBashJail, JAIL_HOME, type JailRunner } from "../../scripts/agent/github-access"
import { scrubbedAgentEnv } from "../../scripts/agent/docs-path-guard"

const model = (() => {
  const r = resolveAgentModel({ ANTHROPIC_API_KEY: "k" })
  if (!r.ok) throw new Error(r.message)
  return r
})()
const base = { model, connectors: [], mcpBaseUrl: "https://compass.test", mcpToken: "t", prompt: "hi", workspaceId: "ws-1", systemPromptAppendices: [], pluginPaths: [], skillIds: [], harness: "claude" as const, docs: true }
const githubEnv = { GH_TOKEN: "ghs_tok", GITHUB_TOKEN: "ghs_tok", AGENT_GITHUB_REPOS: "acme/app" }
const repos = ["acme/app"]

describe("githubShellPrompt", () => {
  it("keeps the no-servers rule and the GitHub-only network for the standard class", () => {
    const prompt = githubShellPrompt(repos)
    expect(prompt).toContain("Do not start background servers")
    expect(prompt).not.toContain("registry.npmjs.org")
    expect(prompt).not.toContain("developer sandbox")
  })

  it("lets the developer class run servers, names the registry and Postgres, and drops the no-servers rule", () => {
    const prompt = githubShellPrompt(repos, true)
    expect(prompt).not.toContain("Do not start background servers")
    expect(prompt).toContain("registry.npmjs.org")
    expect(prompt).toContain("nohup")
    expect(prompt).toContain("initdb")
    expect(prompt).toContain("never print")
  })
})

describe("agentEgressPolicy", () => {
  it("adds only the package registries for the developer class", () => {
    const standard = agentEgressPolicy({ mcpBaseUrl: "https://compass.test" }) as { allow: string[] }
    const developer = agentEgressPolicy({ mcpBaseUrl: "https://compass.test", developer: true }) as { allow: string[] }
    expect(standard.allow).not.toContain("registry.npmjs.org")
    expect([...developer.allow].sort()).toEqual([...standard.allow, "registry.npmjs.org", "npm.pkg.github.com", "pkg-npm.githubusercontent.com", "binaries.prisma.sh"].sort())
  })
})

describe("buildAgentEnv", () => {
  it("forwards the npm token only for a developer run that has a shell", () => {
    const dev = buildAgentEnv({ ...base, githubEnv, developer: { enabled: true, npmToken: "npm_secret" } })
    expect(dev.NPM_TOKEN).toBe("npm_secret")
    expect(dev.AGENT_SANDBOX_CLASS).toBe("DEVELOPER")
    expect(dev.AGENT_SYSTEM_PROMPT).toContain("developer sandbox")
    expect(dev.AGENT_SYSTEM_PROMPT).not.toContain("npm_secret")

    for (const env of [
      buildAgentEnv({ ...base, githubEnv, developer: { enabled: false, npmToken: "npm_secret" } }),
      buildAgentEnv({ ...base, githubEnv }),
      buildAgentEnv({ ...base, githubEnv: undefined, developer: { enabled: true, npmToken: "npm_secret" } }),
      buildAgentEnv({ ...base, harness: "opencode", githubEnv, developer: { enabled: true, npmToken: "npm_secret" } }),
    ]) {
      expect(env.NPM_TOKEN).toBeUndefined()
      expect(env.AGENT_SANDBOX_CLASS).toBeUndefined()
    }
  })

  it("marks the class but sends no token when the host has none", () => {
    expect(developerSandboxEnv(true, undefined)).toEqual({ AGENT_SANDBOX_CLASS: "DEVELOPER" })
    expect(developerSandboxEnv(true, "  ")).toEqual({ AGENT_SANDBOX_CLASS: "DEVELOPER" })
    expect(developerSandboxEnv(false, "npm_secret")).toEqual({})
  })
})

describe("the token inside the sandbox", () => {
  const env = { GH_TOKEN: "ghs_tok", NPM_TOKEN: "npm_secret", AGENT_SANDBOX_CLASS: "DEVELOPER", PATH: "/usr/bin" }

  it("reaches the jail by reference, never as text, and only for the developer class with a token", () => {
    const command = buildJailedCommand("pnpm install", env)
    expect(command).toContain('NPM_TOKEN="$NPM_TOKEN"')
    expect(command).not.toContain("npm_secret")
    expect(buildJailedCommand("pnpm install", { ...env, AGENT_SANDBOX_CLASS: undefined })).not.toContain("NPM_TOKEN")
    expect(buildJailedCommand("pnpm install", { ...env, NPM_TOKEN: "" })).not.toContain("NPM_TOKEN")
  })

  it("is let through to the CLI process only for a developer shell", () => {
    expect(scrubbedAgentEnv(env, { github: true, npm: true }).NPM_TOKEN).toBe("npm_secret")
    expect(scrubbedAgentEnv(env, { github: true }).NPM_TOKEN).toBeUndefined()
    expect(scrubbedAgentEnv(env, {}).NPM_TOKEN).toBeUndefined()
  })

  it("writes an .npmrc that references the variable (never the token), and only when asked", () => {
    const calls: { command: string; args: string[]; input?: string }[] = []
    const run: JailRunner = (command, args, input) => {
      calls.push({ command, args, input })
      if (command === "id" && args[0] === "-gn") return "vercel-sandbox\n"
      if (args.at(-1)?.endsWith("echo ok")) return "ok\n"
      return ""
    }
    prepareBashJail({ docsRoot: "/d", run })
    expect(calls.some((c) => c.args.includes(`${JAIL_HOME}/.npmrc`))).toBe(false)

    calls.length = 0
    prepareBashJail({ docsRoot: "/d", run, npmToken: true })
    const write = calls.find((c) => c.args.includes(`${JAIL_HOME}/.npmrc`) && c.command === "sudo" && c.args.includes("tee"))
    expect(write?.input).toBe("//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n//npm.pkg.github.com/:_authToken=${NPM_TOKEN}\n")
    expect(calls.some((c) => c.args.includes("chmod") && c.args.includes("600") && c.args.includes(`${JAIL_HOME}/.npmrc`))).toBe(true)
  })
})

describe("developerNpmToken", () => {
  it("prefers COMPASS_NPM_TOKEN, falls back to NPM_TOKEN, and treats blank as unset", () => {
    expect(developerNpmToken({ COMPASS_NPM_TOKEN: " ghp_a ", NPM_TOKEN: "npm_b" })).toBe("ghp_a")
    expect(developerNpmToken({ NPM_TOKEN: "npm_b" })).toBe("npm_b")
    expect(developerNpmToken({ COMPASS_NPM_TOKEN: "  ", NPM_TOKEN: "" })).toBeUndefined()
    expect(developerNpmToken({})).toBeUndefined()
  })
})
