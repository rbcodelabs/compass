import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { safeMatter } from "@/lib/safe-matter"

const SENTINEL = "__safeMatterPwned"
const g = globalThis as Record<string, unknown>

afterEach(() => {
  delete g[SENTINEL]
})

describe("safeMatter", () => {
  it.each(["js", "javascript"])("throws on ---%s front matter without executing it", (lang) => {
    const payload = `---${lang}\n(globalThis.${SENTINEL} = true, { title: "x" })\n---\nbody`
    expect(() => safeMatter(payload)).toThrow(/front.?matter/i)
    expect(g[SENTINEL]).toBeUndefined()
  })

  it.each(["json", "toml", "coffee", "cson", "unknown"])("rejects non-yaml language %s", (lang) => {
    expect(() => safeMatter(`---${lang}\n{"a":1}\n---\nbody`)).toThrow(/front.?matter/i)
  })

  it("rejects js delivered via the explicit engines path (yaml block that selects js is not possible)", () => {
    const payload = `---\ntitle: ok\n---js\nglobalThis.${SENTINEL} = true\n---\n`
    // Not a js front-matter block (the opening line is plain ---); must never execute.
    safeMatter(payload)
    expect(g[SENTINEL]).toBeUndefined()
  })

  it("still parses plain and explicit yaml front matter", () => {
    expect(safeMatter("---\ntitle: Hello\ntags: [a, b]\n---\nbody").data).toEqual({ title: "Hello", tags: ["a", "b"] })
    expect(safeMatter("---yaml\ntitle: Hello\n---\nbody").data).toEqual({ title: "Hello" })
    expect(safeMatter("---yaml\ntitle: Hello\n---\nbody").content.trim()).toBe("body")
  })

  it("passes through content without front matter", () => {
    const parsed = safeMatter("# Just markdown\n\ntext")
    expect(parsed.data).toEqual({})
    expect(parsed.content).toBe("# Just markdown\n\ntext")
    expect(parsed.matter).toBe("")
  })
})

describe("gray-matter import guard", () => {
  const root = path.resolve(__dirname, "..")
  const skip = new Set(["node_modules", ".next", ".git", ".worktrees", ".claude", "coverage", ".pnpm-store"])
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      if (skip.has(name)) return []
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) return walk(full)
      return /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(name) ? [full] : []
    })

  it("only lib/safe-matter.ts imports gray-matter", () => {
    const offenders = walk(root)
      .map((f) => path.relative(root, f))
      .filter((f) => f !== "lib/safe-matter.ts" && f !== "__tests__/safe-matter.test.ts")
      .filter((f) => /from\s+["']gray-matter["']|require\(\s*["']gray-matter["']\s*\)|import\(\s*["']gray-matter["']\s*\)/.test(readFileSync(path.join(root, f), "utf8")))
    expect(offenders).toEqual([])
  })
})
