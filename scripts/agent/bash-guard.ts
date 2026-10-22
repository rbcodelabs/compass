// Policy for the agent's Bash tool when GitHub access is enabled (ADR: agent shell
// + GitHub access). Imported by turn-entry.ts as "./bash-guard.ts"; the host route
// writes it into the sandbox next to entry.ts. Node only ERASES types from this
// file at load, so keep it free of enums, namespaces and parameter properties.
//
// What this is, and is not. The boundary that keeps secrets and the rest of the
// sandbox away from Bash is NOT here: it is that every command runs as a separate
// unprivileged Unix user (see github-access.ts), which cannot read this process's
// environment, signal it, or write outside the docs tree and the repo workdir.
// What this file adds is a *guardrail on GitHub writes*: the installation token is
// contents:write, so it refuses the spellings of "push to the default branch",
// "force-push", "delete a branch" and "merge a PR", and the ways of rewriting the
// git configuration that enforces the same thing. A determined prompt-injected
// model can still reach GitHub through an interpreter or raw HTTP, so this is
// defense in depth. The enforcing control is branch protection on the repository.

export type BashDecision = { allowed: true } | { allowed: false; reason: string }

const MAX_COMMAND_CHARS = 10_000

/** Branches a push must never target, whatever the repo's default branch is called. */
export const PROTECTED_BRANCHES = ["main", "master", "trunk", "develop", "development", "release", "production", "prod", "stable"]

const BAD_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

/** Wrappers that run another command: skipped to find what is really being run. */
const TRANSPARENT_WRAPPERS = new Set(["command", "builtin", "nohup", "time", "nice", "env", "timeout", "stdbuf", "ionice", "exec"])
/** Commands that defeat static inspection of what runs next. */
const DENIED_COMMANDS = new Set(["eval", "sudo", "su", "doas", "xargs", "ssh", "scp", "nc", "ncat", "netcat", "socat", "telnet", "setpriv", "unshare", "nsenter", "chroot", "mount", "umount"])
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"])

/** gh subcommands the agent may use; everything else (release, secret, workflow, gist, repo delete, pr merge ...) is refused. */
const GH_ALLOWED: Record<string, Set<string> | "*"> = {
  pr: new Set(["create", "view", "list", "diff", "checkout", "status", "checks", "comment", "edit"]),
  issue: new Set(["view", "list"]),
  repo: new Set(["view", "clone", "list"]),
  run: new Set(["list", "view"]),
  auth: new Set(["status"]),
  search: "*",
  api: "*", // further constrained below: GET only, no fields
}

const GIT_GLOBAL_OPTS_WITH_VALUE = new Set(["-C"])
const GIT_CONFIG_RISKY_KEY = /hookspath|credential|insteadof|pushurl|sshcommand|alias\.|gpg|^url\.|\.helper|include|safe\./i

export type SimpleCommand = { words: string[]; assignments: string[] }

/**
 * Splits a command line into simple commands and DEQUOTES each word, so `g''it`
 * and `"git"` are seen as `git`. Returns a reason string instead when the line
 * uses a construct whose result cannot be known statically.
 */
export function parseCommandLine(line: string): { ok: true; commands: SimpleCommand[] } | { ok: false; reason: string } {
  const commands: SimpleCommand[] = []
  let words: string[] = []
  let word = ""
  let inWord = false
  let quote: "'" | '"' | null = null
  const pushWord = () => {
    if (inWord) words.push(word)
    word = ""
    inWord = false
  }
  const pushCommand = () => {
    pushWord()
    if (words.length === 0) return
    const assignments: string[] = []
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) assignments.push(words.shift() as string)
    commands.push({ words, assignments })
    words = []
  }
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    const next = line[i + 1]
    if (quote === "'") {
      if (ch === "'") quote = null
      else word += ch
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      else if (ch === "\\" && next !== undefined) {
        word += next
        i += 1
      } else if (ch === "`" || (ch === "$" && (next === "(" || next === "{"))) return { ok: false, reason: "command substitution is not allowed" }
      else word += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      inWord = true
      continue
    }
    if (ch === "\\") {
      if (next === "\n") {
        i += 1 // line continuation
        continue
      }
      if (next !== undefined) {
        word += next
        inWord = true
        i += 1
      }
      continue
    }
    if (ch === "`" || (ch === "$" && (next === "(" || next === "{")) || ((ch === "<" || ch === ">") && next === "(")) {
      return { ok: false, reason: "command substitution is not allowed" }
    }
    if (ch === "#" && !inWord) {
      while (i < line.length && line[i] !== "\n") i += 1
      pushCommand()
      continue
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "\n" || ch === "(" || ch === ")" || ch === "{" || ch === "}") {
      // `{` and `}` are only reserved words when they stand alone, but treating
      // them as separators is stricter, never looser.
      if ((ch === "&" || ch === "|") && next === ch) i += 1
      if (ch === "&" && (line[i - 1] === ">" || line[i - 1] === "<" || next === ">")) {
        // `2>&1`, `&>file`: a redirection, not a separator
        word += ch
        inWord = true
        continue
      }
      pushCommand()
      continue
    }
    if (ch === " " || ch === "\t") {
      pushWord()
      continue
    }
    word += ch
    inWord = true
  }
  if (quote) return { ok: false, reason: "unterminated quote" }
  pushCommand()
  return { ok: true, commands }
}

function basename(word: string): string {
  const slash = word.lastIndexOf("/")
  return slash >= 0 ? word.slice(slash + 1) : word
}

/** Skips transparent wrappers (`env`, `time`, `nohup`, ...) and returns the real command's words. */
function resolveCommand(words: string[]): string[] | { deny: string } {
  let rest = words
  for (let guard = 0; guard < 8 && rest.length > 0; guard += 1) {
    const name = basename(rest[0])
    if (!TRANSPARENT_WRAPPERS.has(name)) return rest
    let i = 1
    // options and VAR=value assignments belong to the wrapper
    while (i < rest.length && (rest[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[i]) || (name === "timeout" && /^[0-9.]+[smhd]?$/.test(rest[i])) || (name === "nice" && /^-?[0-9]+$/.test(rest[i])))) {
      if (/^(GIT_|GH_|GITHUB_|LD_|PATH=)/.test(rest[i])) return { deny: `setting ${rest[i].split("=")[0]} is not allowed` }
      i += 1
    }
    rest = rest.slice(i)
  }
  return rest
}

function isProtectedBranch(name: string): boolean {
  const short = name.replace(/^refs\/heads\//, "").replace(/^origin\//, "")
  return PROTECTED_BRANCHES.includes(short.toLowerCase())
}

function checkGitPush(args: string[]): string | null {
  const positional: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === "--") continue
    if (arg.startsWith("--")) {
      const flag = arg.split("=")[0]
      if (/^--(force|force-with-lease|force-if-includes|mirror|delete|all|prune|no-verify|receive-pack|exec|repo|signed)/.test(flag)) return `git push ${flag} is not allowed`
      continue
    }
    if (arg.startsWith("-") && arg.length > 1) {
      // bundled short flags such as -fu
      if (/^-[a-zA-Z]+$/.test(arg) && /[fd]/.test(arg.slice(1))) return `git push ${arg} (force or delete) is not allowed`
      if (arg === "-o") i += 1 // push option takes a value
      continue
    }
    positional.push(arg)
  }
  if (positional.length < 2) return "name the branch explicitly: git push -u origin <your-branch> (never a bare git push)"
  const [remote, ...refspecs] = positional
  if (/[/:@]/.test(remote)) return "push to a named remote (origin), not a URL"
  for (const spec of refspecs) {
    if (spec.includes("$")) return "refspec may not contain shell expansion"
    if (spec.startsWith("+")) return "force refspecs (+ref) are not allowed"
    const [src, dst, ...extra] = spec.split(":")
    if (extra.length > 0) return `unusable refspec ${spec}`
    if (dst !== undefined && src === "") return "deleting a remote branch is not allowed"
    const target = dst === undefined ? src : dst
    if (target === "" || target === undefined) return "deleting a remote branch is not allowed"
    if (target === "HEAD") return "name the branch explicitly; do not push HEAD without a destination branch"
    if (target === "*" || target.includes("*")) return "wildcard refspecs are not allowed"
    if (isProtectedBranch(target)) return `pushing to ${target} is not allowed; push a feature branch and open a pull request`
    if (target.startsWith("refs/") && !target.startsWith("refs/heads/")) return `pushing to ${target} is not allowed`
  }
  return null
}

function checkGit(args: string[]): string | null {
  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === "-c" || (arg.startsWith("-c") && !arg.startsWith("--"))) return "git -c overrides are not allowed"
    if (arg.startsWith("--config-env") || arg.startsWith("--exec-path") || arg.startsWith("--git-dir") || arg.startsWith("--work-tree") || arg.startsWith("--namespace")) return `git ${arg.split("=")[0]} is not allowed`
    if (GIT_GLOBAL_OPTS_WITH_VALUE.has(arg)) {
      i += 2
      continue
    }
    if (arg.startsWith("-")) {
      i += 1
      continue
    }
    break
  }
  const sub = args[i]
  if (sub === undefined) return null
  if (sub.includes("$")) return "git subcommand may not be a shell expansion"
  const rest = args.slice(i + 1)
  if ((sub === "push" || sub === "commit") && rest.includes("--no-verify")) return `git ${sub} --no-verify is not allowed`
  switch (sub) {
    case "push":
      return checkGitPush(rest)
    case "config": {
      const writes = rest.some((a) => /^(--global|--system|--file|-f|--includes|--add|--replace-all|--unset|--unset-all|--edit|-e|--rename-section|--remove-section)$/.test(a)) || rest.some((a) => GIT_CONFIG_RISKY_KEY.test(a))
      return writes ? "changing git configuration (hooks, credentials, urls, aliases) is not allowed" : null
    }
    case "credential":
    case "daemon":
    case "send-pack":
    case "receive-pack":
    case "upload-pack":
    case "remote-https":
      return `git ${sub} is not allowed`
    case "remote":
      return rest.some((a) => /^(set-url|add|rename|remove|rm|set-head|set-branches)$/.test(a)) ? "changing git remotes is not allowed" : null
    case "update-ref":
    case "symbolic-ref":
      return rest.some((a) => /refs\/(heads|remotes)\/(origin\/)?(main|master|trunk)/.test(a)) && !rest.includes("--short") ? `git ${sub} on a protected ref is not allowed` : null
    default:
      return null
  }
}

function checkGh(args: string[]): string | null {
  const positional = args.filter((a) => !a.startsWith("-"))
  const [group, action] = positional
  if (group === undefined) return null
  const allowed = GH_ALLOWED[group]
  if (!allowed) return `gh ${group} is not allowed; the agent may use gh pr, gh repo view/clone, gh run, gh search and read-only gh api`
  if (allowed !== "*" && !(action !== undefined && allowed.has(action))) return `gh ${group} ${action ?? ""} is not allowed`
  if (group === "pr" && args.some((a) => /^--(admin|auto|squash|rebase|merge)$/.test(a))) return "merging pull requests is not allowed"
  if (group === "pr" && action === "create" && args.some((a) => /^--(base|head)(=|$)/.test(a))) {
    const baseIdx = args.findIndex((a) => a === "--head" || a.startsWith("--head="))
    if (baseIdx >= 0) {
      const value = args[baseIdx].includes("=") ? args[baseIdx].split("=")[1] : args[baseIdx + 1]
      if (value && isProtectedBranch(value.replace(/^[^:]*:/, ""))) return "a pull request head cannot be a protected branch"
    }
  }
  if (group === "api") {
    const methodIdx = args.findIndex((a) => a === "-X" || a === "--method" || a.startsWith("--method=") || (a.startsWith("-X") && a.length > 2))
    if (methodIdx >= 0) {
      const a = args[methodIdx]
      const value = a.startsWith("--method=") ? a.slice("--method=".length) : a.startsWith("-X") && a.length > 2 ? a.slice(2) : args[methodIdx + 1]
      if (!/^get$/i.test(value ?? "")) return "gh api is limited to GET"
    }
    if (args.some((a) => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(a) || /^-[fF]./.test(a))) return "gh api with request fields or a body is not allowed (it would be a write)"
    if (positional.includes("graphql")) return "gh api graphql is not allowed"
  }
  return null
}

function checkHttpTool(name: string, args: string[]): string | null {
  const touchesGithub = args.some((a) => /github\.com|githubusercontent\.com/i.test(a))
  if (!touchesGithub) return null
  const writeFlags = new Set(["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--json", "-F", "--form", "-T", "--upload-file", "--post-data", "--post-file", "--body-data", "--body-file", "--method", "--request", "-X"])
  const writes = args.some((a) => writeFlags.has(a.split("=")[0]) || /^-(d|X|F|T)./.test(a))
  return writes ? `${name} writes to GitHub are not allowed; use git push to a branch and gh pr create` : null
}

export function checkBashCommand(command: unknown): BashDecision {
  if (typeof command !== "string" || command.trim().length === 0) return { allowed: false, reason: "Blocked: the command is empty." }
  if (command.length > MAX_COMMAND_CHARS) return { allowed: false, reason: "Blocked: the command is too long; split it up." }
  if (BAD_CONTROL_CHARS.test(command)) return { allowed: false, reason: "Blocked: the command contains a control character." }
  const parsed = parseCommandLine(command)
  if (!parsed.ok) return { allowed: false, reason: `Blocked: ${parsed.reason}. Write the command out literally.` }
  for (const simple of parsed.commands) {
    for (const assignment of simple.assignments) {
      if (/^(GIT_|GH_|GITHUB_|LD_|PATH=|HOME=)/.test(assignment)) return { allowed: false, reason: `Blocked: setting ${assignment.split("=")[0]} is not allowed.` }
    }
    const resolved = resolveCommand(simple.words)
    if (!Array.isArray(resolved)) return { allowed: false, reason: `Blocked: ${resolved.deny}.` }
    if (resolved.length === 0) continue
    const name = basename(resolved[0])
    if (resolved[0].includes("$")) return { allowed: false, reason: "Blocked: the command name may not be a shell expansion." }
    if (DENIED_COMMANDS.has(name)) return { allowed: false, reason: `Blocked: ${name} is not available.` }
    const args = resolved.slice(1)
    if (SHELLS.has(name) && args.some((a) => /^-[a-zA-Z]*c/.test(a))) return { allowed: false, reason: "Blocked: do not start a nested shell with -c; run the commands directly." }
    let problem: string | null = null
    if (name === "git") problem = checkGit(args)
    else if (name === "gh") problem = checkGh(args)
    else if (name === "curl" || name === "wget" || name === "http" || name === "https") problem = checkHttpTool(name, args)
    if (problem) return { allowed: false, reason: `Blocked: ${problem}.` }
  }
  return { allowed: true }
}
