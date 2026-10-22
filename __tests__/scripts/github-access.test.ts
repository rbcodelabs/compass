/**
 * Sandbox-side half of the agent shell + GitHub access (scripts/agent/github-access.ts):
 * the gating, the tools list, the rewrite that runs every Bash command as the jail user
 * with a clean environment, the jail setup, and the pre-push hook (executed for real
 * against throwaway git repositories).
 */
import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  agentTools,
  buildJailedCommand,
  createBashPreToolUseHook,
  githubAccessFromEnv,
  JAIL_GITCONFIG,
  JAIL_USER,
  prePushHook,
  prepareBashJail,
  REPOS_DIR,
  systemGitConfig,
  type JailRunner,
} from "../../scripts/agent/github-access"

const on = { AGENT_GITHUB_SHELL: "1", GH_TOKEN: "ghs_x", AGENT_GITHUB_REPOS: "rbcodelabs/compass,rbcodelabs/docs" }

describe("githubAccessFromEnv (gating)", () => {
  it("is enabled only with the host switch, a token, a repo list and a docs root", () => {
    expect(githubAccessFromEnv(on, "/docs")).toEqual({ enabled: true, repos: ["rbcodelabs/compass", "rbcodelabs/docs"] })
  })

  it.each([
    ["no host switch", { ...on, AGENT_GITHUB_SHELL: undefined }, "/docs"],
    ["switch not 1", { ...on, AGENT_GITHUB_SHELL: "true" }, "/docs"],
    ["no token", { ...on, GH_TOKEN: undefined }, "/docs"],
    ["blank token", { ...on, GH_TOKEN: "  " }, "/docs"],
    ["no repos", { ...on, AGENT_GITHUB_REPOS: undefined }, "/docs"],
    ["empty repos", { ...on, AGENT_GITHUB_REPOS: " , " }, "/docs"],
    ["no docs root (claim-scoped runs)", on, undefined],
  ])("is disabled: %s", (_name, env, docsRoot) => {
    expect(githubAccessFromEnv(env, docsRoot).enabled).toBe(false)
  })
})

describe("agentTools", () => {
  it("never includes Bash unless the shell is on, and never without docs", () => {
    expect(agentTools(false, false)).toEqual(["WebFetch"])
    expect(agentTools(false, true)).toEqual(["WebFetch"])
    expect(agentTools(true, false)).toEqual(["WebFetch", "Read", "Write", "Edit", "Glob"])
    expect(agentTools(true, true)).toEqual(["WebFetch", "Read", "Write", "Edit", "Glob", "Bash"])
  })
})

describe("buildJailedCommand", () => {
  const env = {
    PATH: "/vercel/runtimes/node24/bin:/home/vercel-sandbox/.global/npm/bin:/opt/git/bin:/usr/bin",
    SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
    GIT_SSL_CAINFO: "/etc/ssl/certs/ca-certificates.crt",
    MCP_TOKEN: "mcp-secret",
    AGENT_RUN_TOKEN: "run-secret",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    GH_TOKEN: "ghs_real_token",
  }

  it("runs as the jail user under env -i with no-new-privs, and carries the command only as base64", () => {
    const command = buildJailedCommand("git status && echo 'hi; rm -rf /'", env)
    expect(command.startsWith(`sudo -n -u ${JAIL_USER} env -i `)).toBe(true)
    expect(command).toContain("setpriv --no-new-privs bash --noprofile --norc -c")
    expect(command).toContain(`cd ${REPOS_DIR}`)
    expect(command).not.toContain("rm -rf")
    const encoded = command.match(/printf %s ([A-Za-z0-9+/=]+) \| base64 -d/)?.[1]
    expect(Buffer.from(encoded ?? "", "base64").toString("utf8")).toBe("git status && echo 'hi; rm -rf /'")
  })

  it("hands over the token by reference and no other secret, by value or name", () => {
    const command = buildJailedCommand("env", env)
    expect(command).toContain('GH_TOKEN="$GH_TOKEN"')
    for (const secret of ["ghs_real_token", "mcp-secret", "run-secret", "sk-ant-secret", "MCP_TOKEN", "AGENT_RUN_TOKEN", "ANTHROPIC_API_KEY"]) {
      expect(command).not.toContain(secret)
    }
  })

  it("passes through only the CA-bundle paths git needs, and a PATH without home-directory entries", () => {
    const command = buildJailedCommand("true", env)
    expect(command).toContain("GIT_SSL_CAINFO='/etc/ssl/certs/ca-certificates.crt'")
    expect(command).toContain("PATH='/vercel/runtimes/node24/bin:/opt/git/bin:/usr/bin'")
    expect(command).not.toContain("/home/vercel-sandbox")
  })

  it("drops a pass-through value with shell metacharacters rather than quoting it", () => {
    expect(buildJailedCommand("true", { ...env, SSL_CERT_FILE: "/x; curl evil" })).not.toContain("curl evil")
  })

  it("pins the git configuration to the root-owned system file", () => {
    expect(buildJailedCommand("true", env)).toContain(`GIT_CONFIG_SYSTEM=${JAIL_GITCONFIG}`)
  })
})

describe("createBashPreToolUseHook", () => {
  const hook = createBashPreToolUseHook({ PATH: "/usr/bin" })
  const decision = (out: Record<string, unknown>) => (out.hookSpecificOutput as Record<string, unknown>) ?? {}

  it("rewrites an allowed command into the jail and keeps the tool's other inputs", async () => {
    const out = decision(await hook({ tool_name: "Bash", tool_input: { command: "git status", description: "d", timeout: 5000 } }))
    expect(out.permissionDecision).toBe("allow")
    const updated = out.updatedInput as Record<string, unknown>
    expect(updated.command).toContain(`sudo -n -u ${JAIL_USER}`)
    expect(updated).toMatchObject({ description: "d", timeout: 5000, dangerouslyDisableSandbox: false })
  })

  it("forces the sandbox-disable switch off even if the model sets it", async () => {
    const out = decision(await hook({ tool_name: "Bash", tool_input: { command: "ls", dangerouslyDisableSandbox: true } }))
    expect((out.updatedInput as Record<string, unknown>).dangerouslyDisableSandbox).toBe(false)
  })

  it("denies a policy violation with the reason and no rewrite", async () => {
    const out = decision(await hook({ tool_name: "Bash", tool_input: { command: "git push --force origin main" } }))
    expect(out.permissionDecision).toBe("deny")
    expect(out.permissionDecisionReason).toMatch(/Blocked/)
    expect(out).not.toHaveProperty("updatedInput")
  })

  it("fails closed on malformed events", async () => {
    for (const event of [undefined, null, {}, { tool_name: "Read", tool_input: { command: "ls" } }, { tool_name: "Bash" }, { tool_name: "Bash", tool_input: { command: 3 } }]) {
      expect(decision(await hook(event)).permissionDecision).toBe("deny")
    }
  })
})

describe("prepareBashJail", () => {
  function recorder(failOn?: (command: string, args: string[]) => boolean) {
    const calls: { command: string; args: string[]; input?: string }[] = []
    const run: JailRunner = (command, args, input) => {
      calls.push({ command, args, input })
      if (failOn?.(command, args)) throw new Error(`${command} failed`)
      if (command === "id" && args[0] === "-gn") return "vercel-sandbox\n"
      if (args.includes("echo ok") || args.at(-1)?.endsWith("echo ok")) return "ok\n"
      return ""
    }
    return { calls, run }
  }

  it("creates the user, shares only a group, installs the root-owned git policy and probes the jail", () => {
    const { calls, run } = recorder((command, args) => command === "id" && args[0] === JAIL_USER)
    prepareBashJail({ docsRoot: "/vercel/sandbox/docs", run })
    const flat = calls.map((c) => [c.command, ...c.args].join(" "))
    expect(flat.some((c) => c.startsWith("sudo -n useradd") && c.includes(JAIL_USER))).toBe(true)
    expect(flat).toContain(`sudo -n usermod -aG vercel-sandbox ${JAIL_USER}`)
    expect(flat).toContain(`chmod -R g+rwX /vercel/sandbox/docs ${REPOS_DIR}`)
    expect(calls.find((c) => c.args.includes(JAIL_GITCONFIG))?.input).toBe(systemGitConfig())
    expect(calls.some((c) => c.input === prePushHook())).toBe(true)
    expect(flat.at(-1)).toContain(`sudo -n -u ${JAIL_USER} env -i bash`)
  })

  it("does not recreate an existing user", () => {
    const { calls, run } = recorder()
    prepareBashJail({ docsRoot: "/d", run })
    expect(calls.some((c) => c.args.includes("useradd"))).toBe(false)
  })

  it("tolerates a failed hidepid remount (defense in depth) but not a failed required step", () => {
    const notes: string[] = []
    const { run } = recorder((_c, args) => args.includes("hidepid=2") || args.includes("remount,hidepid=2"))
    expect(() => prepareBashJail({ docsRoot: "/d", run, note: (m) => notes.push(m) })).not.toThrow()
    expect(notes.join(" ")).toContain("hidepid")

    const failing = recorder((_c, args) => args.includes("usermod"))
    expect(() => prepareBashJail({ docsRoot: "/d", run: failing.run })).toThrow()
  })

  it("throws when the final probe cannot write the workdir, so the turn runs without a shell", () => {
    const run: JailRunner = (_command, args) => (args[0] === "-gn" ? "g" : "")
    expect(() => prepareBashJail({ docsRoot: "/d", run })).toThrow(/cannot write/)
  })
})

describe("systemGitConfig", () => {
  it("sets the agent identity, a token-from-env credential helper and the hooks path, quoting the helper", () => {
    const config = systemGitConfig()
    expect(config).toContain("name = Compass Agent")
    expect(config).toContain("email = compass-agent@users.noreply.github.com")
    expect(config).toContain('[credential "https://github.com"]')
    expect(config).toContain("GH_TOKEN:-$GITHUB_TOKEN")
    expect(config).toContain("hooksPath = /etc/agent-git/hooks")
    expect(config).not.toMatch(/ghs_|github_pat_/)
  })
})

describe("pre-push hook (executed against real repositories)", () => {
  const zero = "0".repeat(40)
  const tmp = mkdtempSync(path.join(tmpdir(), "prepush-"))
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim()

  const remote = path.join(tmp, "remote.git")
  const work = path.join(tmp, "work")
  git(tmp, "init", "--bare", "-b", "main", remote)
  git(tmp, "clone", remote, work)
  writeFileSync(path.join(work, "a.txt"), "a")
  git(work, "add", "-A")
  git(work, "commit", "-m", "one")
  git(work, "push", "origin", "main") // the hook is not installed yet: seeds the remote
  git(work, "remote", "set-head", "origin", "main")
  const first = git(work, "rev-parse", "HEAD")
  writeFileSync(path.join(work, "a.txt"), "b")
  git(work, "commit", "-am", "two")
  const second = git(work, "rev-parse", "HEAD")

  const hookPath = path.join(tmp, "pre-push")
  writeFileSync(hookPath, prePushHook())
  chmodSync(hookPath, 0o755)

  function runHook(lines: string): { code: number; stderr: string } {
    try {
      execFileSync(hookPath, ["origin", "url"], { cwd: work, input: lines, stdio: ["pipe", "pipe", "pipe"] })
      return { code: 0, stderr: "" }
    } catch (error) {
      const e = error as { status: number; stderr: Buffer }
      return { code: e.status, stderr: e.stderr.toString() }
    }
  }

  it("allows a fast-forward push of a new feature branch", () => {
    expect(runHook(`refs/heads/agent/x ${second} refs/heads/agent/x ${zero}\n`).code).toBe(0)
  })

  it("allows a fast-forward update of an existing feature branch", () => {
    expect(runHook(`refs/heads/agent/x ${second} refs/heads/agent/x ${first}\n`).code).toBe(0)
  })

  it("refuses the default branch and the protected names", () => {
    for (const branch of ["main", "master", "release"]) {
      const result = runHook(`refs/heads/${branch} ${second} refs/heads/${branch} ${first}\n`)
      expect(result.code, branch).toBe(1)
      expect(result.stderr).toMatch(/agent push policy/)
    }
  })

  it("refuses the repository's default branch even when it has an unusual name", () => {
    git(work, "update-ref", "refs/remotes/origin/trunk-x", first)
    git(work, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk-x")
    const result = runHook(`refs/heads/trunk-x ${second} refs/heads/trunk-x ${first}\n`)
    git(work, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/default branch/)
  })

  it("refuses deletion, tags and non-fast-forward (force) pushes", () => {
    expect(runHook(`(delete) ${zero} refs/heads/agent/x ${first}\n`).stderr).toMatch(/deleting/)
    expect(runHook(`refs/tags/v1 ${second} refs/tags/v1 ${zero}\n`).stderr).toMatch(/only branch pushes/)
    // `first` is not a descendant of `second`: rewriting agent/x from second back to first is a force push.
    expect(runHook(`refs/heads/agent/x ${first} refs/heads/agent/x ${second}\n`).stderr).toMatch(/non-fast-forward/)
  })

  it("refuses when any one ref in a multi-ref push is bad", () => {
    expect(runHook(`refs/heads/agent/a ${second} refs/heads/agent/a ${zero}\nrefs/heads/main ${second} refs/heads/main ${first}\n`).code).toBe(1)
  })

  afterAll(() => rmSync(tmp, { recursive: true, force: true }))
})
