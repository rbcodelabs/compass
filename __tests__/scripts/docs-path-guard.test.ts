/**
 * The agent's native file tools must stay inside the docs directory
 * (scripts/agent/docs-path-guard.ts). Under bypassPermissions the SDK confines
 * nothing by itself, so `Read /proc/self/environ` would return AGENT_RUN_TOKEN,
 * MCP_TOKEN, ANTHROPIC_API_KEY and MCP_BYPASS_SECRET. These tests drive the
 * guard against a real directory tree, including symlinks.
 *
 * The same hook was also exercised live against the Agent SDK 0.3.224 under
 * permissionMode "bypassPermissions": a Read of a sibling file outside cwd came
 * back as "Blocked: file_path is outside the docs directory" (see the PR notes).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  AGENT_PRIVATE_ENV,
  DOCS_GUARDED_TOOLS_MATCHER,
  checkDocsToolUse,
  checkWebFetch,
  createAllowedUrls,
  createDocsPreToolUseHook,
  createSearchResultCollector,
  createWebFetchPreToolUseHook,
  extractUrls,
  normalizeFetchUrl,
  scrubbedAgentEnv,
  WEB_SEARCH_MATCHER,
} from "../../scripts/agent/docs-path-guard"

let base: string
let root: string
let outside: string

beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), "docs-guard-"))
  root = path.join(base, "docs")
  outside = path.join(base, "outside")
  mkdirSync(path.join(root, "Product"), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(path.join(root, "Product", "_doc.md"), "# doc")
  writeFileSync(path.join(base, "entry.ts"), "SECRET ENTRY SOURCE")
  writeFileSync(path.join(base, "docs-manifest.json"), "{}")
  writeFileSync(path.join(outside, "secret.txt"), "top secret")
  // Escape hatches an agent (or a doc) could plant inside the root.
  symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link-to-secret.md"))
  symlinkSync(outside, path.join(root, "link-to-outside-dir"))
  symlinkSync(path.join(root, "Product"), path.join(root, "link-inside"))
  // A symlink back up to the root, so that "Product/up/../outside/x" is, to the kernel, "<base>/outside/x".
  symlinkSync("..", path.join(root, "Product", "up"))
  // Dangling links: realpath fails on them exactly as on a missing file, so a naive guard
  // treats them as "not created yet" while Write follows the link and creates the target.
  symlinkSync(path.join(outside, "will-be-created.txt"), path.join(root, "dangling-out"))
  symlinkSync(path.join(root, "nowhere", "yet.md"), path.join(root, "dangling-in"))
})

afterAll(() => rmSync(base, { recursive: true, force: true }))

const allowed = (tool: string, input: unknown) => checkDocsToolUse(tool, input, root).allowed
const denied = (tool: string, input: unknown) => !checkDocsToolUse(tool, input, root).allowed

describe("checkDocsToolUse: allowed", () => {
  it("allows files inside the docs root, relative or absolute", () => {
    expect(allowed("Read", { file_path: "Product/_doc.md" })).toBe(true)
    expect(allowed("Read", { file_path: path.join(root, "Product", "_doc.md") })).toBe(true)
    expect(allowed("Edit", { file_path: "Product/_doc.md", old_string: "a", new_string: "b" })).toBe(true)
  })

  it("allows creating a new file or a new directory chain inside the root", () => {
    expect(allowed("Write", { file_path: "Product/Child/_doc.md", content: "x" })).toBe(true)
    expect(allowed("Write", { file_path: "Brand New/Deeper/_doc.md", content: "x" })).toBe(true)
  })

  it("allows a symlink that stays inside the root", () => {
    expect(allowed("Read", { file_path: "link-inside/_doc.md" })).toBe(true)
  })

  it("allows Glob over the root and relative patterns", () => {
    expect(allowed("Glob", { pattern: "**/_doc.md" })).toBe(true)
    expect(allowed("Glob", { pattern: "Product/*.md", path: root })).toBe(true)
    expect(allowed("Glob", { pattern: "*.md", path: "Product" })).toBe(true)
  })
})

describe("checkDocsToolUse: denied", () => {
  it("denies /proc/self/environ, the headline secret exposure, for every file tool", () => {
    for (const tool of ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]) {
      expect(denied(tool, { file_path: "/proc/self/environ" }), tool).toBe(true)
    }
    expect(denied("NotebookEdit", { notebook_path: "/proc/self/environ" })).toBe(true)
  })

  it("denies the other procfs, sysfs and etc routes to the same secrets", () => {
    for (const p of ["/proc/1/environ", "/proc/self/cmdline", "/proc/thread-self/environ", "/proc/self/fd/3", "/proc/self/mem", "/etc/passwd", "/sys/kernel/notes", "/root/.ssh/id_rsa", "/dev/stdin"]) {
      expect(denied("Read", { file_path: p }), p).toBe(true)
    }
  })

  it("denies the entry script, the manifest and every sibling of the docs root", () => {
    expect(denied("Read", { file_path: path.join(base, "entry.ts") })).toBe(true)
    expect(denied("Edit", { file_path: path.join(base, "entry.ts") })).toBe(true)
    expect(denied("Write", { file_path: path.join(base, "entry.ts"), content: "x" })).toBe(true)
    // "docs-manifest.json" shares the textual prefix "docs": a bare startsWith would let it through.
    expect(denied("Read", { file_path: path.join(base, "docs-manifest.json") })).toBe(true)
    expect(denied("Read", { file_path: path.join(base, "docs-evil", "x") })).toBe(true)
  })

  it("denies ../ traversal in every spelling", () => {
    expect(denied("Read", { file_path: "../entry.ts" })).toBe(true)
    expect(denied("Read", { file_path: "Product/../../entry.ts" })).toBe(true)
    expect(denied("Read", { file_path: path.join(root, "..", "entry.ts") })).toBe(true)
    expect(denied("Read", { file_path: path.join(root, "Product", "..", "..", "entry.ts") })).toBe(true)
    expect(denied("Write", { file_path: "../escaped/_doc.md", content: "x" })).toBe(true)
  })

  it("denies a symlink-plus-dot-dot path the kernel resolves outside the root even though a lexical collapse stays inside", () => {
    // path.resolve("<root>/Product/up/../outside/secret.txt") = "<root>/Product/outside/secret.txt" (inside, and absent),
    // but opening the raw string follows `up` -> <root> first and reads <base>/outside/secret.txt.
    expect(denied("Read", { file_path: "Product/up/../outside/secret.txt" })).toBe(true)
    // Built by concatenation: path.join would collapse the ".." lexically and test a different string.
    expect(denied("Read", { file_path: `${root}/Product/up/../outside/secret.txt` })).toBe(true)
    expect(denied("Write", { file_path: "Product/up/../outside/new.md", content: "x" })).toBe(true)
    expect(denied("Glob", { pattern: "*", path: "Product/up/../outside" })).toBe(true)
    // the escape the guard must not be fooled by really exists
    expect(readFileSync(`${root}/Product/up/../outside/secret.txt`, "utf8")).toBe("top secret")
    // a plain symlink to the root stays fine
    expect(allowed("Read", { file_path: "Product/up/Product/_doc.md" })).toBe(true)
  })

  it("denies a dangling symlink, whether its missing target is outside or inside the root", () => {
    for (const tool of ["Write", "Read", "Edit"]) {
      expect(denied(tool, { file_path: "dangling-out" }), tool).toBe(true)
      expect(denied(tool, { file_path: "dangling-in" }), tool).toBe(true)
    }
    // ...including as an intermediate directory component
    expect(denied("Write", { file_path: "dangling-out/child.md", content: "x" })).toBe(true)
    expect(denied("Glob", { pattern: "*", path: "dangling-out" })).toBe(true)
  })

  it("denies a symlink inside the root that points outside it, as a file and as a directory", () => {
    expect(denied("Read", { file_path: "link-to-secret.md" })).toBe(true)
    expect(denied("Read", { file_path: "link-to-outside-dir/secret.txt" })).toBe(true)
    expect(denied("Edit", { file_path: "link-to-secret.md", old_string: "a", new_string: "b" })).toBe(true)
  })

  it("denies creating a NEW file through a symlinked directory that leads outside", () => {
    expect(denied("Write", { file_path: "link-to-outside-dir/new.md", content: "x" })).toBe(true)
    expect(denied("Write", { file_path: "link-to-outside-dir/a/b/c.md", content: "x" })).toBe(true)
  })

  it("denies a missing, empty, non-string or NUL-bearing path (fail closed)", () => {
    expect(denied("Read", {})).toBe(true)
    expect(denied("Read", { file_path: "" })).toBe(true)
    expect(denied("Read", { file_path: 5 })).toBe(true)
    expect(denied("Read", { file_path: ["a"] })).toBe(true)
    expect(denied("Read", { file_path: "Product/_doc.md\0/../../entry.ts" })).toBe(true)
    expect(denied("Read", null)).toBe(true)
    expect(denied("Read", "Product/_doc.md")).toBe(true)
  })

  it("denies every spelling the Claude CLI would normalize before opening (whitespace trim, ~ expansion)", () => {
    // The CLI trims a path argument and expands ~ and ~/ to the home directory, so a guard that
    // resolved the raw string approved all of these while the tool read something else.
    const spellings = [
      " /proc/self/environ",
      "/proc/self/environ ",
      "\n/proc/self/cmdline",
      "/proc/self/cmdline\n",
      "\t/proc/self/environ",
      "\r\n/etc/passwd",
      "\u00a0/proc/self/environ", // no-break space
      "\u2028/proc/self/environ", // line separator
      "\u3000/proc/self/environ", // ideographic space
      "\ufeff/proc/self/environ", // BOM
      " Product/_doc.md",
      "Product/_doc.md ",
      "~/.bashrc",
      "~/x",
      "~",
      "~root/.ssh/id_rsa",
      "~+/x",
      "~-/x",
      "~user",
      " ~/x",
      "$HOME/.bashrc",
      "${HOME}/.bashrc",
      "%HOME%/.bashrc",
      "Product/$X",
      "Product/50%",
      "\"Product/_doc.md\"",
      "'Product/_doc.md'",
      "\u0060Product/_doc.md\u0060",
      "file:///etc/passwd",
      "Product/\n/../../entry.ts",
      "Product/\u0000",
      "Product/\u0085x", // C1 NEL
      "Product/\u007fx",
    ]
    for (const tool of ["Read", "Write", "Edit"]) {
      for (const file_path of spellings) expect(denied(tool, { file_path }), `${tool} ${JSON.stringify(file_path)}`).toBe(true)
    }
    expect(denied("Glob", { pattern: "*", path: "~" })).toBe(true)
    expect(denied("Glob", { pattern: "*", path: " /proc" })).toBe(true)
    expect(denied("Glob", { pattern: "*", path: "~/" })).toBe(true)
    expect(denied("Glob", { pattern: " *.md" })).toBe(true)
    expect(denied("Glob", { pattern: "*.md\n" })).toBe(true)
    expect(denied("Glob", { pattern: "$HOME/*" })).toBe(true)
    expect(denied("Glob", { pattern: "~/*" })).toBe(true)
    expect(denied("NotebookEdit", { notebook_path: "~/x.ipynb" })).toBe(true)
  })

  it("denies /proc, /sys and /dev by name, including through ./ and // spellings", () => {
    for (const p of ["/proc", "/proc/", "/proc//self/environ", "/proc/./self/environ", "//proc/self/environ", "/sys", "/dev/null", "/dev/../proc/self/environ", path.join(root, "..", "..", "..", "..", "..", "proc", "self", "environ")]) {
      expect(denied("Read", { file_path: p }), p).toBe(true)
    }
  })

  it("still allows interior spaces and ordinary punctuation that real doc names contain", () => {
    expect(allowed("Write", { file_path: "Q3 Plan (draft)/_doc.md", content: "x" })).toBe(true)
    expect(allowed("Write", { file_path: "Rick's plan/_doc.md", content: "x" })).toBe(true)
    expect(allowed("Write", { file_path: "日本語 notes/_doc.md", content: "x" })).toBe(true)
  })

  it("denies a path field smuggled onto any tool, and Glob roots/patterns that escape", () => {
    expect(denied("SomeOtherTool", { path: "/etc" })).toBe(true)
    expect(denied("Glob", { pattern: "*", path: "/etc" })).toBe(true)
    expect(denied("Glob", { pattern: "*", path: "/proc" })).toBe(true)
    expect(denied("Glob", { pattern: "/etc/*" })).toBe(true)
    expect(denied("Glob", { pattern: "../*" })).toBe(true)
    expect(denied("Glob", { pattern: "Product/../../*" })).toBe(true)
    expect(denied("Glob", { pattern: "{/etc/passwd,x}" })).toBe(true)
    expect(denied("Glob", { pattern: "a,/etc/passwd" })).toBe(true)
    expect(denied("Glob", { pattern: "~/x" })).toBe(true)
    expect(denied("Glob", { pattern: "C:/x" })).toBe(true)
    expect(denied("Glob", { pattern: 7 })).toBe(true)
    expect(denied("Glob", {})).toBe(true)
    expect(denied("Grep", { pattern: "x", glob: "../*" })).toBe(true)
    expect(denied("Glob", { pattern: "*", path: "link-to-outside-dir" })).toBe(true)
  })

  it("denies everything when the docs directory itself is unavailable", () => {
    expect(checkDocsToolUse("Read", { file_path: "x" }, path.join(base, "missing-root")).allowed).toBe(false)
  })
})

describe("the PreToolUse hook the SDK calls", () => {
  const hook = () => createDocsPreToolUseHook(root)

  it("returns a deny decision for /proc/self/environ and for the entry script", async () => {
    for (const file_path of ["/proc/self/environ", path.join(base, "entry.ts")]) {
      const out = (await hook()({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path }, tool_use_id: "t" })) as {
        hookSpecificOutput?: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string }
      }
      expect(out.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" })
      expect(out.hookSpecificOutput?.permissionDecisionReason).toMatch(/system path|outside the docs directory/)
    }
  })

  it("lets an in-root read continue", async () => {
    expect(await hook()({ tool_name: "Read", tool_input: { file_path: "Product/_doc.md" } })).toEqual({ continue: true })
  })

  it("fails closed on malformed hook input", async () => {
    const out = (await hook()(undefined)) as { hookSpecificOutput?: { permissionDecision: string } }
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny")
  })

  it("fails closed when checking throws (a hostile or malformed input must never read as no objection)", async () => {
    const hostile = {
      get tool_name(): string {
        throw new Error("boom")
      },
    }
    const out = (await hook()(hostile)) as { hookSpecificOutput?: { permissionDecision: string } }
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny")
    const webOut = (await createWebFetchPreToolUseHook(new Set())({
      get tool_input(): unknown {
        throw new Error("boom")
      },
    })) as { hookSpecificOutput?: { permissionDecision: string } }
    expect(webOut.hookSpecificOutput?.permissionDecision).toBe("deny")
  })

  it("is registered for every path-taking tool", () => {
    for (const tool of ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep"]) {
      expect(new RegExp(`^(${DOCS_GUARDED_TOOLS_MATCHER})$`).test(tool), tool).toBe(true)
    }
  })
})

describe("scrubbedAgentEnv (allow-list)", () => {
  it("passes only what the CLI needs and drops everything else, including variables added later", () => {
    const out = scrubbedAgentEnv({
      PATH: "/usr/bin",
      HOME: "/root",
      LANG: "C.UTF-8",
      LC_ALL: "C",
      XDG_CONFIG_HOME: "/x",
      NODE_OPTIONS: "--max-old-space-size=4096",
      ANTHROPIC_API_KEY: "sk-ant",
      ANTHROPIC_BASE_URL: "https://gw",
      CLAUDE_CODE_USE_FOO: "1",
      HTTPS_PROXY: "http://p",
      NODE_EXTRA_CA_CERTS: "/ca.pem",
      AGENT_PROMPT: "the whole prompt",
      AGENT_RUN_ID: "run",
      AGENT_MCP_CONNECTORS: "[]",
      MCP_BASE_URL: "https://c",
      DOCS_ROOT: "/vercel/sandbox/docs",
      SOME_NEW_SECRET: "shh",
      AWS_SECRET_ACCESS_KEY: "aws",
      DATABASE_URL: "postgres://x",
    })
    expect(Object.keys(out).sort()).toEqual(
      ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_FOO", "HOME", "HTTPS_PROXY", "LANG", "LC_ALL", "NODE_EXTRA_CA_CERTS", "NODE_OPTIONS", "PATH", "XDG_CONFIG_HOME"],
    )
  })

  it("never passes the entry script's credentials even if a prefix rule would otherwise match", () => {
    const out = scrubbedAgentEnv({ AGENT_RUN_TOKEN: "run", MCP_TOKEN: "mcp", MCP_BYPASS_SECRET: "b", PATH: "/usr/bin" })
    expect(out).toEqual({ PATH: "/usr/bin" })
  })

  it("removes the entry script's own credentials but keeps what the CLI needs", () => {
    const out = scrubbedAgentEnv({
      AGENT_RUN_TOKEN: "run",
      MCP_TOKEN: "mcp",
      MCP_BYPASS_SECRET: "bypass",
      ANTHROPIC_API_KEY: "sk-ant",
      PATH: "/usr/bin",
    })
    for (const name of AGENT_PRIVATE_ENV) expect(out).not.toHaveProperty(name)
    expect(out.ANTHROPIC_API_KEY).toBe("sk-ant")
    expect(out.PATH).toBe("/usr/bin")
  })

  it("does not mutate the environment it was given", () => {
    const env = { MCP_TOKEN: "mcp" }
    scrubbedAgentEnv(env)
    expect(env.MCP_TOKEN).toBe("mcp")
  })
})

describe("web_search result collection uses the tool name the CLI really reports", () => {
  // Observed live against Agent SDK 0.3.224: an MCP server registered as "web_search" with one tool
  // "web_search" is reported to hooks as "mcp__web_search__web_search", and tool_response is the
  // array of MCP content blocks.
  const REAL_TOOL_NAME = "mcp__web_search__web_search"
  const matches = (matcher: string, toolName: string) =>
    // A matcher made only of [A-Za-z0-9_|] is an EXACT tool name; anything else is a regex.
    /^[A-Za-z0-9_|]*$/.test(matcher) ? matcher.split("|").includes(toolName) : new RegExp(`^(?:${matcher})$`).test(toolName)

  it("the matcher selects the real tool name, and not other Compass or connector tools", () => {
    expect(matches(WEB_SEARCH_MATCHER, REAL_TOOL_NAME)).toBe(true)
    expect(matches(WEB_SEARCH_MATCHER, "mcp__compass__list_docs")).toBe(false)
    expect(matches(WEB_SEARCH_MATCHER, "mcp__web_search_evil__web_search")).toBe(false)
    expect(matches(WEB_SEARCH_MATCHER, "WebFetch")).toBe(false)
  })

  it("a bare server-prefix matcher would NOT have matched (the bug this replaces)", () => {
    expect(matches("mcp__web_search", REAL_TOOL_NAME)).toBe(false)
  })

  it("end to end: a search result with the real response shape makes its URL fetchable", async () => {
    const allowed = createAllowedUrls("")
    const fetchHook = createWebFetchPreToolUseHook(allowed)
    const target = { tool_name: "WebFetch", tool_input: { url: "https://found.example/page" } }
    expect(((await fetchHook(target)) as { hookSpecificOutput?: unknown }).hookSpecificOutput).toBeDefined()
    if (matches(WEB_SEARCH_MATCHER, REAL_TOOL_NAME)) {
      await createSearchResultCollector(allowed)({
        hook_event_name: "PostToolUse",
        tool_name: REAL_TOOL_NAME,
        tool_input: { query: "x" },
        tool_response: [{ type: "text", text: "1. Result https://found.example/page - a snippet" }],
      })
    }
    expect(await fetchHook(target)).toEqual({ continue: true })
  })
})

describe("WebFetch exfiltration guard", () => {
  const allowed = createAllowedUrls("Please summarise https://example.com/article?id=7, and also see (https://docs.example.org/a/b).")

  it("extracts URLs from prose without trailing punctuation or brackets", () => {
    expect(extractUrls("see https://a.test/x. and https://b.test/y?q=1, (https://c.test/z)")).toEqual([
      "https://a.test/x",
      "https://b.test/y?q=1",
      "https://c.test/z",
    ])
  })

  it("allows exactly the URLs the user wrote", () => {
    expect(checkWebFetch({ url: "https://example.com/article?id=7", prompt: "x" }, allowed).allowed).toBe(true)
    expect(checkWebFetch({ url: "https://docs.example.org/a/b" }, allowed).allowed).toBe(true)
  })

  it("denies a model-invented URL, including one that appends data to an allowed URL", () => {
    for (const url of [
      "https://attacker.example/?d=SECRET",
      "https://attacker.example/SECRET",
      "https://example.com/article?id=7&d=SECRET",
      "https://example.com/article?id=7#SECRET-is-dropped-so-this-is-allowed-elsewhere",
      "https://example.com/article",
      "https://example.com/article/SECRET",
      "https://example.com.attacker.example/article?id=7",
      "https://user:pass@example.com/article?id=7",
      "http://example.com/article?id=7",
    ]) {
      // The fragment variant normalizes to an allowed URL; everything else must be refused.
      const expectAllowed = url.includes("#SECRET-is-dropped")
      expect(checkWebFetch({ url }, allowed).allowed, url).toBe(expectAllowed)
    }
  })

  it("denies non-URLs, non-http schemes and padded values", () => {
    for (const url of [undefined, 5, "", " https://example.com/article?id=7", "https://example.com/article?id=7\n", "file:///etc/passwd", "javascript:alert(1)", "ftp://example.com/", "not a url"]) {
      expect(checkWebFetch({ url }, allowed).allowed, String(url)).toBe(false)
    }
    expect(checkWebFetch(null, allowed).allowed).toBe(false)
  })

  it("normalizes so equivalent spellings of an allowed URL match", () => {
    expect(normalizeFetchUrl("https://Example.com:443/article?id=7")).toBe("https://example.com/article?id=7")
    expect(checkWebFetch({ url: "https://EXAMPLE.com/article?id=7" }, allowed).allowed).toBe(true)
  })

  it("makes URLs returned by web_search fetchable, and only from that tool's results", async () => {
    const set = createAllowedUrls("no urls here")
    const hook = createWebFetchPreToolUseHook(set)
    const call = { tool_name: "WebFetch", tool_input: { url: "https://found.example/page" } }
    expect(((await hook(call)) as { hookSpecificOutput?: { permissionDecision: string } }).hookSpecificOutput?.permissionDecision).toBe("deny")
    await createSearchResultCollector(set)({ tool_response: { content: [{ type: "text", text: "1. Title https://found.example/page - snippet" }] } })
    expect(await hook(call)).toEqual({ continue: true })
    expect(((await hook({ tool_input: { url: "https://found.example/other" } })) as { hookSpecificOutput?: { permissionDecision: string } }).hookSpecificOutput?.permissionDecision).toBe("deny")
  })

  it("caps how many URLs a search result can make fetchable", async () => {
    const set = createAllowedUrls("")
    const urls = Array.from({ length: 800 }, (_, i) => `https://s.example/${i}`).join(" ")
    await createSearchResultCollector(set)({ tool_response: urls })
    expect(set.size).toBeLessThanOrEqual(500)
  })
})
