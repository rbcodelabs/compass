import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

/** Prisma delegate names of the 14 numbered models, checked against the schema in the guard test. */
export const NUMBERED_DELEGATES = [
  "objective",
  "keyResult",
  "opportunity",
  "solution",
  "assumption",
  "experiment",
  "task",
  "roadmapItem",
  "feedbackItem",
  "reviewRequest",
  "doc",
  "artifact",
  "researchStudy",
  "metricDefinition",
] as const

const WRITE_OPERATIONS = ["create", "createMany", "createManyAndReturn", "upsert"] as const
const CALL = new RegExp(`\\.(${NUMBERED_DELEGATES.join("|")})\\.(${WRITE_OPERATIONS.join("|")})\\s*\\(`, "g")

export type CreateSite = {
  file: string
  line: number
  model: string
  operation: string
  /** Text of the call's argument list, comments removed. */
  args: string
}

/** Removes comments but keeps string contents and line breaks, so offsets still map to lines. */
export function stripComments(source: string): string {
  let out = ""
  let i = 0
  let quote: string | null = null
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (quote) {
      out += ch
      if (ch === "\\") {
        out += next ?? ""
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i++
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch
      out += ch
      i++
      continue
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++
      continue
    }
    if (ch === "/" && next === "*") {
      i += 2
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") out += "\n"
        i++
      }
      i += 2
      continue
    }
    out += ch
    i++
  }
  return out
}

/** Returns the text between the parenthesis that opens at `open` and its match, skipping string literals. */
function balancedArguments(source: string, open: number): string {
  let depth = 0
  let quote: string | null = null
  for (let i = open; i < source.length; i++) {
    const ch = source[i]
    if (quote) {
      if (ch === "\\") i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch
    else if (ch === "(") depth++
    else if (ch === ")" && --depth === 0) return source.slice(open + 1, i)
  }
  return source.slice(open + 1)
}

export function scanSource(file: string, raw: string): CreateSite[] {
  const source = stripComments(raw)
  const sites: CreateSite[] = []
  for (const match of source.matchAll(CALL)) {
    const open = (match.index ?? 0) + match[0].length - 1
    sites.push({
      file,
      line: source.slice(0, match.index).split("\n").length,
      model: match[1],
      operation: match[2],
      args: balancedArguments(source, open),
    })
  }
  return sites
}

/** Raw SQL inserts into numbered tables, which bypass the Prisma delegates entirely. */
export function scanRawInserts(file: string, raw: string, tables: readonly string[]): { file: string; line: number; table: string }[] {
  const source = stripComments(raw)
  const found: { file: string; line: number; table: string }[] = []
  const pattern = new RegExp(`INSERT\\s+INTO\\s+(?:"?[\\w$\\{\\}.]+"?\\.)?"?(${tables.join("|")})"?[\\s(]`, "gi")
  for (const match of source.matchAll(pattern)) {
    found.push({ file, line: source.slice(0, match.index).split("\n").length, table: match[1].toLowerCase() })
  }
  return found
}

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".next", ".git", ".worktrees", "__tests__", "e2e", "prisma", "docs", "public"])
const SOURCE_FILE = /\.(ts|tsx|mts|mjs)$/
const TEST_FILE = /\.(test|spec|integration\.test)\.[cm]?tsx?$/

export function listSourceFiles(root: string, directories: readonly string[]): string[] {
  const files: string[] = []
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      if (SKIPPED_DIRECTORIES.has(entry)) continue
      const full = path.join(directory, entry)
      const info = statSync(full)
      if (info.isDirectory()) visit(full)
      else if (SOURCE_FILE.test(entry) && !TEST_FILE.test(entry)) files.push(path.relative(root, full))
    }
  }
  for (const directory of directories) visit(path.join(root, directory))
  return files.sort()
}

export function readSource(root: string, file: string): string {
  return readFileSync(path.join(root, file), "utf-8")
}
