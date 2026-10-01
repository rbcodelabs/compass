/**
 * Pulls user-visible copy fragments out of a component's SOURCE TEXT, so the same
 * extractors can read origin/main's files (literals) and this branch's files
 * (literals plus `labels.x.y` expressions).
 *
 * Phase 4C-2: rebuilt on the TypeScript parser (it was line-based text scanning).
 * The line scanner could not see copy inside one-line conditionals
 * (`{!compact && <p>… key result …</p>}`), which is exactly where it missed
 * components/analytics/measurements-panel.tsx. Parsing walks every string
 * literal, template literal and JSX text node regardless of layout.
 *
 * Still a comparison aid and a tripwire, not a proof: it sees source text, not
 * strings assembled elsewhere or imported from another module.
 *
 * Self-contained apart from `typescript`, so scripts/regenerate-thinking-model-baselines.ts
 * can load it directly under Node.
 */
import ts from "typescript"

export const ENTITY_WORD =
  /\b(objectives?|key[ -]results?|krs?|okrs?|outcomes?|opportunit(?:y|ies)|solutions?|cycles?|success metrics?)\b/i

type LabelValues = Record<string, Record<string, string>>

const OPEN = "⟦"
const CLOSE = "⟧"

const norm = (s: string) => s.replace(/\s+/g, " ").trim()

function parse(source: string, fileName: string): ts.SourceFile {
  const kind = /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind)
}

/** `labels.cycle.lowerPlural` (also `x.labels.cycle.lowerPlural`) => token; any other expression => `{}`. */
function exprToken(expr: string): string {
  const m = expr.trim().match(/(?:^|[.\s(])labels\.(\w+)\.(\w+)\s*$/)
  return m ? `${OPEN}${m[1]}.${m[2]}${CLOSE}` : "{}"
}

/** A template literal as text, with each `${expr}` tokenised. */
function templateText(node: ts.TemplateExpression, sf: ts.SourceFile): string {
  return node.head.text + node.templateSpans.map((span) => exprToken(span.expression.getText(sf)) + span.literal.text).join("")
}

/**
 * Text of an expression that may sit directly in JSX children: a label token, a
 * string/template literal, or an opaque `{}`.
 */
function jsxExpressionText(expr: ts.Expression | undefined, sf: ts.SourceFile): string {
  if (!expr) return ""
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text
  if (ts.isTemplateExpression(expr)) return templateText(expr, sf)
  return exprToken(expr.getText(sf))
}

/**
 * Every user-visible-looking fragment: each string / template literal, and each
 * run of JSX children between elements (text with `{labels.x.y}` tokens, so
 * "Add {labels.objective.lower} now" is one fragment, as it reads on screen).
 */
export function copyFragments(source: string, fileName = "file.tsx"): string[] {
  const sf = parse(source, fileName)
  const out: string[] = []
  const push = (text: string) => {
    const n = norm(text)
    if (n) out.push(n)
  }

  function flushChildren(children: ts.NodeArray<ts.JsxChild>) {
    let buffer = ""
    const flush = () => {
      push(buffer)
      buffer = ""
    }
    for (const child of children) {
      if (ts.isJsxText(child)) buffer += child.text
      else if (ts.isJsxExpression(child)) {
        const e = child.expression
        // A conditional / logical expression holds elements and strings of its own: those are visited below as
        // separate fragments, and it ends the current text run.
        if (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isTemplateExpression(e) || ts.isPropertyAccessExpression(e) || ts.isIdentifier(e) || ts.isCallExpression(e) || ts.isElementAccessExpression(e))) buffer += jsxExpressionText(e, sf)
        else if (e) {
          flush()
        }
      } else flush() // an element: ends the run
    }
    flush()
  }

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      push(node.text)
      return
    }
    if (ts.isTemplateExpression(node)) {
      push(templateText(node, sf))
      node.templateSpans.forEach((span) => visit(span.expression))
      return
    }
    if (ts.isJsxElement(node)) flushChildren(node.children)
    else if (ts.isJsxFragment(node)) flushChildren(node.children)
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** Replace label tokens with concrete values (CLASSIC, in the tests). */
export function substitute(fragment: string, labels: LabelValues): string {
  return norm(
    fragment.replace(new RegExp(`${OPEN}(\\w+)\\.(\\w+)${CLOSE}`, "g"), (_, a: string, b: string) => labels[a]?.[b] ?? `${OPEN}${a}.${b}${CLOSE}`),
  )
}

/** The entity-bearing fragments of a main-branch file: what must still be producible under CLASSIC. */
export function entityFragments(source: string, fileName = "file.tsx"): string[] {
  return [...new Set(copyFragments(source, fileName).filter((f) => ENTITY_WORD.test(f)))]
}

// ---------------------------------------------------------------------------------------------------------------------
// Tripwire scan: raw entity words left in copy.
// ---------------------------------------------------------------------------------------------------------------------

/** Attributes / property names whose string value is copy even when it is a lone lowercase word. */
const COPY_POSITIONS = new Set([
  "label",
  "aria-label",
  "placeholder",
  "title",
  "alt",
  "emptyMessage",
  "inputPlaceholder",
  "description",
  "templateLabel",
  "caption",
  "header",
  "text",
  "message",
  "summary",
])

/** Identifier-looking: one token that is not a capitalized word ("objective", "OBJECTIVE", "keyResult", "/okrs/"). */
const identifierLike = (text: string) => !/\s/.test(text) && !/^[A-Z][a-z]+s?$/.test(text)

/**
 * Raw entity words in string literals, template literal text and JSX text. The
 * parser-based replacement for the earlier line scanner: it also sees copy inside
 * one-line conditionals and multi-line JSX.
 */
export function rawEntityCopy(source: string, fileName = "file.tsx"): string[] {
  const sf = parse(source, fileName)
  const hits: string[] = []
  const add = (text: string) => {
    const n = norm(text)
    if (n && ENTITY_WORD.test(n)) hits.push(n)
  }

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isLiteralTypeNode(node)) return
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const p = node.parent
      let copyPosition = false
      if (ts.isJsxAttribute(p)) copyPosition = COPY_POSITIONS.has(p.name.getText(sf))
      else if (ts.isPropertyAssignment(p) && p.initializer === node) copyPosition = COPY_POSITIONS.has(p.name.getText(sf))
      const isKey = ts.isPropertyAssignment(p) && p.name === node
      const isIndex = ts.isElementAccessExpression(p) && p.argumentExpression === node
      const isComparison =
        ts.isCaseClause(p) ||
        (ts.isBinaryExpression(p) &&
          [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(p.operatorToken.kind))
      if (!isKey && !isIndex && !isComparison && (copyPosition || !identifierLike(node.text))) add(node.text)
      return
    }
    if (ts.isTemplateExpression(node)) {
      // The static text only, with each ${…} removed. No whitespace is added where one was: `outcome-${id}-row` is an id.
      const text = node.head.text + node.templateSpans.map((span) => span.literal.text).join("")
      if (/\s/.test(text.trim())) add(text)
      node.templateSpans.forEach((span) => visit(span.expression))
      return
    }
    if (ts.isJsxText(node)) {
      const text = norm(node.text)
      // A lone lowercase word between tags is prose too, but a lone Capitalized or lowercase token is rare; keep the old rule:
      // one word counts only when capitalized.
      const words = text.split(/\s+/)
      if (text && ENTITY_WORD.test(text) && (words.length >= 2 || /^[A-Z]/.test(text))) hits.push(text)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return hits
}
