// Agent shell + GitHub access (ADR: agent shell + GitHub access, which reverses the
// Bash exclusion of ADR 0019 §2.2/2.3 for workspaces that opt in). Imported by
// turn-entry.ts as "./github-access.ts"; the host route writes it into the sandbox
// next to entry.ts. Node only ERASES types from this file at load, so keep it free
// of enums, namespaces and parameter properties.
//
// Threat model in one paragraph. Bash is the first tool that could read this
// process's environment (MCP bearer, run token, model key) and could send it
// anywhere the network allows. So Bash is never run as the user that owns those
// secrets. Every command is rewritten (PreToolUse `updatedInput`) to run as a
// dedicated, unprivileged Unix user: it cannot read /proc/<pid>/environ of this
// process, cannot signal or ptrace it, cannot write outside the docs tree and the
// repo workdir, and has no sudo. `env -i` hands it only the GitHub token, PATH,
// HOME and what git needs. The network policy (set by the host at sandbox creation)
// is the second wall: only GitHub, Compass and the model provider are reachable.
// bash-guard.ts adds the GitHub-write guardrails on top.

import { execFileSync } from "node:child_process"
import { checkBashCommand, PROTECTED_BRANCHES } from "./bash-guard.ts"

/** The Unix user every agent Bash command runs as. */
export const JAIL_USER = "agentbash"
export const JAIL_HOME = "/home/agentbash"
/** Root-owned, so the jail user cannot edit the git configuration that enforces the push policy. */
export const JAIL_GIT_DIR = "/etc/agent-git"
export const JAIL_GITCONFIG = `${JAIL_GIT_DIR}/gitconfig`
export const JAIL_HOOKS_DIR = `${JAIL_GIT_DIR}/hooks`
/** The dedicated working directory for clones, shared between the entry user and the jail user. */
export const REPOS_DIR = "/vercel/sandbox/repos"

export const AGENT_GIT_NAME = "Compass Agent"
export const AGENT_GIT_EMAIL = "compass-agent@users.noreply.github.com"

type Env = Record<string, string | undefined>

export type GithubAccess = { enabled: true; repos: string[] } | { enabled: false; reason: string }

/**
 * Whether this turn gets Bash + GitHub. All of: the host said so (AGENT_GITHUB_SHELL), a
 * token was minted, a non-empty repo list came with it, and the docs tree is materialized
 * (the docs guard hooks are what the rest of the file-tool policy hangs on, so a run
 * without them -- claim-scoped handoffs -- never gets a shell).
 */
export function githubAccessFromEnv(env: Env, docsRoot: string | undefined): GithubAccess {
  if (env.AGENT_GITHUB_SHELL !== "1") return { enabled: false, reason: "not enabled by the host" }
  if (!env.GH_TOKEN?.trim()) return { enabled: false, reason: "no GitHub token was minted" }
  const repos = (env.AGENT_GITHUB_REPOS ?? "").split(",").map((r) => r.trim()).filter(Boolean)
  if (repos.length === 0) return { enabled: false, reason: "the workspace has no approved repositories" }
  if (!docsRoot) return { enabled: false, reason: "docs are not materialized for this run" }
  return { enabled: true, repos }
}

/** The SDK `tools` list: the real gate on what the agent may call (allowedTools gates nothing under bypassPermissions). */
export function agentTools(docs: boolean, shell: boolean): string[] {
  if (!docs) return ["WebFetch"]
  return shell ? ["WebFetch", "Read", "Write", "Edit", "Glob", "Bash"] : ["WebFetch", "Read", "Write", "Edit", "Glob"]
}

/** The Bash guard matcher: exactly the Bash tool. */
export const BASH_MATCHER = "Bash"

// ── git configuration enforced inside the jail ──────────────────────────────

export function systemGitConfig(): string {
  // `;` and `#` start a comment in a git config value unless the value is quoted, hence the quoting.
  const helper = '"!f() { test \\"$1\\" = get || exit 0; echo username=x-access-token; echo \\"password=${GH_TOKEN:-$GITHUB_TOKEN}\\"; }; f"'
  return [
    "[user]",
    `\tname = ${AGENT_GIT_NAME}`,
    `\temail = ${AGENT_GIT_EMAIL}`,
    '[credential "https://github.com"]',
    "\thelper =",
    `\thelper = ${helper}`,
    "[core]",
    `\thooksPath = ${JAIL_HOOKS_DIR}`,
    "[init]",
    "\tdefaultBranch = main",
    "[advice]",
    "\tdetachedHead = false",
    "[safe]",
    "\tdirectory = *",
    "",
  ].join("\n")
}

/** A client-side backstop for the push policy. The enforcing control is branch protection on GitHub. */
export function prePushHook(): string {
  return `#!/bin/bash
# Compass agent push policy: feature branches only, fast-forward only.
zero=0000000000000000000000000000000000000000
default=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')
deny() { echo "agent push policy: $1" >&2; exit 1; }
while read -r local_ref local_sha remote_ref remote_sha; do
  case "$remote_ref" in refs/heads/*) ;; *) deny "only branch pushes are allowed ($remote_ref)";; esac
  branch="\${remote_ref#refs/heads/}"
  [ "$local_sha" = "$zero" ] && deny "deleting remote branches is not allowed"
  for protected in ${PROTECTED_BRANCHES.join(" ")}; do
    [ "$branch" = "$protected" ] && deny "do not push to $branch; push a feature branch and open a pull request"
  done
  [ -n "$default" ] && [ "$branch" = "$default" ] && deny "do not push to the default branch ($default); open a pull request from a feature branch"
  if [ "$remote_sha" != "$zero" ] && ! git merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null; then
    deny "non-fast-forward (force) pushes are not allowed"
  fi
done
exit 0
`
}

// ── running a command as the jail user ──────────────────────────────────────

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Variables the jail inherits from this process: non-secret paths git/curl/node need to trust the sandbox CA. */
const JAIL_PASSTHROUGH = ["SSL_CERT_FILE", "GIT_SSL_CAINFO", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS", "NPM_CONFIG_CAFILE"]

export function jailPath(env: Env): string {
  const entries = (env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(":").filter((p) => p && !p.startsWith("/home/"))
  return entries.join(":") || "/usr/local/bin:/usr/bin:/bin"
}

/**
 * Rewrites a model-written command into one that runs as the jail user with a clean
 * environment. The original text travels base64-encoded so no quoting in it can
 * break out of the wrapper. The token is NOT in the returned text: it is read from
 * the tool process's own environment when the command runs (`$GH_TOKEN`), so it
 * never lands in a transcript.
 *
 * `env -i` is load-bearing: sudo here does not reset the environment, so without it
 * the jail would inherit every variable of the tool process.
 */
export function buildJailedCommand(userCommand: string, env: Env = process.env): string {
  const passthrough = JAIL_PASSTHROUGH.flatMap((name) => {
    const value = env[name]
    return value && /^[\w./:@+-]+$/.test(value) ? [`${name}=${shellQuote(value)}`] : []
  })
  const encoded = Buffer.from(userCommand, "utf8").toString("base64")
  const inner = `umask 002; cd ${REPOS_DIR} || exit 1; eval "$(printf %s ${encoded} | base64 -d)"`
  return [
    "sudo -n -u",
    JAIL_USER,
    "env -i",
    `PATH=${shellQuote(jailPath(env))}`,
    `HOME=${JAIL_HOME}`,
    `USER=${JAIL_USER}`,
    "LANG=C.UTF-8",
    `GIT_CONFIG_SYSTEM=${JAIL_GITCONFIG}`,
    "GIT_TERMINAL_PROMPT=0",
    "GH_PROMPT_DISABLED=1",
    "GH_NO_UPDATE_NOTIFIER=1",
    'GH_TOKEN="$GH_TOKEN"',
    'GITHUB_TOKEN="${GITHUB_TOKEN:-$GH_TOKEN}"',
    // DEVELOPER class only, and only when the host had a token: read from this process, like GH_TOKEN, never written into command text.
    ...(env.AGENT_SANDBOX_CLASS === "DEVELOPER" && env.NPM_TOKEN?.trim() ? ['NPM_TOKEN="$NPM_TOKEN"'] : []),
    ...passthrough,
    "setpriv --no-new-privs",
    "bash --noprofile --norc -c",
    shellQuote(inner),
  ].join(" ")
}

function deny(reason: string): Record<string, unknown> {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }
}

/** PreToolUse hook for Bash: policy check, then rewrite into the jail. Fails closed. */
export function createBashPreToolUseHook(env: Env = process.env) {
  return async function bashPreToolUse(input: unknown): Promise<Record<string, unknown>> {
    try {
      const event = (input ?? {}) as { tool_name?: unknown; tool_input?: unknown }
      if (event.tool_name !== "Bash") return deny("Blocked: malformed tool call")
      const toolInput = event.tool_input && typeof event.tool_input === "object" ? (event.tool_input as Record<string, unknown>) : {}
      const decision = checkBashCommand(toolInput.command)
      if (!decision.allowed) return deny(decision.reason)
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { ...toolInput, command: buildJailedCommand(toolInput.command as string, env), dangerouslyDisableSandbox: false },
        },
      }
    } catch {
      return deny("Blocked: the command could not be checked")
    }
  }
}

// ── one-time setup of the jail at the start of a turn ───────────────────────

export type JailRunner = (command: string, args: string[], input?: string) => string

const defaultRunner: JailRunner = (command, args, input) =>
  execFileSync(command, args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], timeout: 60_000 })

/**
 * Creates the jail user and the files it needs, then proves a command can actually run
 * as it. Throws if any REQUIRED step fails; the caller then runs the turn WITHOUT a shell.
 * Idempotent. `run` is injectable for tests.
 */
export function prepareBashJail(opts: { docsRoot: string; run?: JailRunner; note?: (message: string) => void; npmToken?: boolean }): void {
  const run = opts.run ?? defaultRunner
  const note = opts.note ?? (() => {})
  const sudo = (...args: string[]) => run("sudo", ["-n", ...args])

  let exists = true
  try {
    run("id", [JAIL_USER])
  } catch {
    exists = false
  }
  if (!exists) sudo("useradd", "--system", "--create-home", "--home-dir", JAIL_HOME, "--shell", "/bin/bash", JAIL_USER)
  const group = run("id", ["-gn"]).trim()
  sudo("usermod", "-aG", group, JAIL_USER)

  // The jail user shares a GROUP with this process, never its identity: group-writable docs
  // and repo workdir, setgid so files it creates stay readable and removable by this process.
  run("mkdir", ["-p", REPOS_DIR])
  run("chmod", ["-R", "g+rwX", opts.docsRoot, REPOS_DIR])
  run("find", [opts.docsRoot, REPOS_DIR, "-type", "d", "-exec", "chmod", "g+s", "{}", "+"])

  sudo("mkdir", "-p", JAIL_HOOKS_DIR)
  run("sudo", ["-n", "tee", JAIL_GITCONFIG], systemGitConfig())
  run("sudo", ["-n", "tee", `${JAIL_HOOKS_DIR}/pre-push`], prePushHook())
  sudo("chmod", "755", `${JAIL_HOOKS_DIR}/pre-push`)
  sudo("chmod", "644", JAIL_GITCONFIG)

  // DEVELOPER class with a token: let npm and pnpm authenticate to the registry. The file holds a REFERENCE to $NPM_TOKEN, never the
  // token, which the jail receives per command in its environment. Written only when a token exists, because npm refuses to start
  // when .npmrc names an unset variable.
  if (opts.npmToken) {
    run("sudo", ["-n", "tee", `${JAIL_HOME}/.npmrc`], "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n//npm.pkg.github.com/:_authToken=${NPM_TOKEN}\n");
    sudo("chown", `${JAIL_USER}:`, `${JAIL_HOME}/.npmrc`);
    sudo("chmod", "600", `${JAIL_HOME}/.npmrc`);
  }

  // Hide this process's siblings from the jail user's /proc view. Defense in depth: the
  // uid separation already denies environ/ptrace/kill, so a failure here is not fatal.
  try {
    sudo("mount", "-o", "remount,hidepid=2", "/proc")
  } catch (error) {
    note(`could not remount /proc with hidepid=2 (continuing): ${error instanceof Error ? error.message : String(error)}`)
  }

  // Prove the whole path (sudo -> jail user -> writable workdir) before promising a shell.
  const probe = run("sudo", ["-n", "-u", JAIL_USER, "env", "-i", "bash", "--noprofile", "--norc", "-c", `cd ${REPOS_DIR} && test -w . && echo ok`]).trim()
  if (probe !== "ok") throw new Error("the jail user cannot write the repo workdir")
}

/** Appended to the system prompt when the shell could not be set up after the host promised one. */
export const SHELL_UNAVAILABLE_NOTICE =
  "\n\n## Shell unavailable this turn\n\nThe shell and GitHub access described above could not be set up for this turn. " +
  "You do NOT have Bash or GitHub access right now. Do not attempt to use them; tell the user if their request needs it."
