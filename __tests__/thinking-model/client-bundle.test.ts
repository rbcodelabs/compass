import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * TRIPWIRE for client bundle weight, not a bundle measurement.
 *
 * The client provider imports lib/thinking-model/resolve.ts, so everything that
 * module (transitively) imports ships in every workspace page. Keep that closure
 * free of zod and of server-only modules. This walks the static relative imports
 * of the client-reachable modules and fails on any bare-package or server import.
 * It does not run a bundler; a dynamic import or a re-export through a barrel
 * would escape it.
 */

const ROOT = process.cwd()
const ENTRY = ["components/thinking-model/thinking-model-provider.tsx", "lib/thinking-model/copy.ts"]
// Allowed non-relative imports: React itself and this repo's own client-safe modules.
const ALLOWED_BARE = new Set(["react"])

function importsOf(file: string): string[] {
  const source = readFileSync(path.join(ROOT, file), "utf-8")
  return [...source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^"']*?from\s+["']([^"']+)["']/g)].map((m) => m[1])
}

function resolveLocal(spec: string, from: string): string | null {
  const base = spec.startsWith("@/") ? spec.slice(2) : path.join(path.dirname(from), spec)
  for (const ext of [".ts", ".tsx", "/index.ts"]) {
    try {
      readFileSync(path.join(ROOT, base + ext))
      return base + ext
    } catch {}
  }
  return null
}

describe("the thinking-model client closure stays light", () => {
  it("imports no zod, no server module, no unexpected package", () => {
    const seen = new Set<string>()
    const bad: string[] = []
    const visit = (file: string) => {
      if (seen.has(file)) return
      seen.add(file)
      for (const spec of importsOf(file)) {
        const local = spec.startsWith("@/") || spec.startsWith(".") ? resolveLocal(spec, file) : null
        if (local) {
          visit(local)
        } else if (!ALLOWED_BARE.has(spec)) {
          bad.push(`${file} imports ${spec}`)
        }
      }
    }
    ENTRY.forEach(visit)
    expect(bad).toEqual([])
    expect([...seen].some((f) => f.endsWith("lib/thinking-model/resolve.ts"))).toBe(true)
    expect([...seen].some((f) => f.endsWith("lib/thinking-model/validate.ts"))).toBe(true)
  })
})
