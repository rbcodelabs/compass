import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import ts from "typescript"

/**
 * Static scan for Prisma writes that can change a followable model's status
 * (ADR "Following and in-app notifications", section 2.5, "Bypass guard").
 *
 * Status writes are not centralized, so a path nobody wired to the following
 * emitter is a silent gap. This turns it into a red test. It is an AST scan, not
 * a runtime interceptor, so it has two honest blind spots that the guard test
 * documents: a model reached through a dynamic delegate (`(client as any)[name]`)
 * and a write made by a raw SQL statement.
 */
export type StatusWriteSite = {
  file: string
  line: number
  model: string
  operation: string
  /** "literal" when `data` is an object literal that names the status field; "dynamic" when it cannot be read statically. */
  evidence: "literal" | "dynamic"
  /** Wrapped in captureWorkspaceMutation, the adapter that emits following events. */
  viaAdapter: boolean
}

/** Prisma delegate name -> the column that carries lifecycle state for it. */
export const STATUS_FIELD_BY_MODEL: Record<string, string> = {
  task: "status",
  opportunity: "status",
  solution: "status",
  assumption: "status",
  experiment: "status",
  roadmapItem: "status",
  feedbackItem: "status",
  objective: "status",
  researchStudy: "status",
  reviewRequest: "state",
  artifact: "status",
  metricDefinition: "archived",
}

const OPERATIONS = new Set(["update", "updateMany", "upsert"])
const SKIP_DIRS = new Set(["node_modules", ".next", ".claude", ".worktrees", "generated", "__tests__", "e2e", "scripts", "prisma"])

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(full)
  }
}

function propertyName(node: ts.PropertyName | undefined): string | null {
  if (!node) return null
  return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : null
}

function dataEvidence(arg: ts.Expression | undefined, field: string, operation: string): "literal" | "dynamic" | null {
  if (!arg || !ts.isObjectLiteralExpression(arg)) return "dynamic"
  const targets = operation === "upsert" ? ["update", "create"] : ["data"]
  let dynamic = false
  for (const prop of arg.properties) {
    const name = ts.isShorthandPropertyAssignment(prop) ? prop.name.text : propertyName((prop as ts.PropertyAssignment).name)
    if (!name || !targets.includes(name)) continue
    const value = ts.isPropertyAssignment(prop) ? prop.initializer : ts.isShorthandPropertyAssignment(prop) ? prop.name : null
    if (!value || !ts.isObjectLiteralExpression(value)) { dynamic = true; continue }
    for (const inner of value.properties) {
      if (ts.isSpreadAssignment(inner)) { dynamic = true; continue }
      const innerName = ts.isShorthandPropertyAssignment(inner) ? inner.name.text : propertyName((inner as ts.PropertyAssignment).name)
      if (innerName === field) return "literal"
    }
  }
  return dynamic ? "dynamic" : null
}

function inAdapter(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === "captureWorkspaceMutation") return true
  }
  return false
}

export function scanStatusWrites(root: string, dirs: string[] = ["lib", "app"]): StatusWriteSite[] {
  const files: string[] = []
  for (const dir of dirs) {
    const full = path.join(root, dir)
    if (existsSync(full)) walk(full, files)
  }
  const sites: StatusWriteSite[] = []
  for (const file of files.sort()) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const operation = node.expression.name.text
        const target = node.expression.expression
        if (OPERATIONS.has(operation) && ts.isPropertyAccessExpression(target)) {
          const model = target.name.text
          const field = STATUS_FIELD_BY_MODEL[model]
          if (field) {
            const evidence = dataEvidence(node.arguments[0], field, operation)
            if (evidence) {
              sites.push({
                file: path.relative(root, file).split(path.sep).join("/"),
                line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
                model, operation, evidence, viaAdapter: inAdapter(node),
              })
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return sites
}
