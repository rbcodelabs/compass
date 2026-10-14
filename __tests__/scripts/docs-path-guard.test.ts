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
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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
      expect(out.hookSpecificOutput?.permissionDecisionReason).toMatch(/outside the docs directory/)
    }
  })

  it("lets an in-root read continue", async () => {
    expect(await hook()({ tool_name: "Read", tool_input: { file_path: "Product/_doc.md" } })).toEqual({ continue: true })
  })

  it("fails closed on malformed hook input", async () => {
    const out = (await hook()(undefined)) as { hookSpecificOutput?: { permissionDecision: string } }
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny")
  })

  it("is registered for every path-taking tool", () => {
    for (const tool of ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep"]) {
      expect(new RegExp(`^(${DOCS_GUARDED_TOOLS_MATCHER})$`).test(tool), tool).toBe(true)
    }
  })
})

describe("scrubbedAgentEnv", () => {
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
