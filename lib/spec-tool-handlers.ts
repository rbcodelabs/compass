/**
 * Handlers for the Spec MCP tools (spec docs phase 2): create_spec and list_specs. (get_spec is phase 3.)
 *
 * Authorization already ran in lib/mcp-tool-gates.ts: workspace membership plus the scope entity resolved IN the declared workspace.
 * createSpecCore / listSpecDocs still re-verify the scope inside that workspace, so a scope in another workspace and one that does not
 * exist produce the same message. Extracted here, like lib/feedback-tool-handlers.ts, so the behavior is unit-testable without the route.
 *
 * Read/write symmetry: create_spec returns the doc's path, which is also how write_doc, edit_doc (by id), delete_doc and the docs://
 * resource address it; list_specs returns the same id, title, path and label that create_spec reported. The create response carries the
 * new doc id on its own `ID: <uuid>` line.
 */
import getPrisma from "@/lib/db"
import { fail, ok } from "@/lib/mcp-output"
import { safeEntityUrl } from "@/lib/compass-url"
import { documentMcpActor } from "@/lib/document-mcp-actor"
import * as docFs from "@/lib/doc-fs"
import { createSpecCore, listSpecDocs, scopeNotFoundMessage } from "@/lib/spec-docs/create"
import type { SpecScopeType } from "@/lib/spec-docs/scopes"
import type { SpecTemplateVariant } from "@/lib/spec-docs/template"

async function docUrl(workspaceId: string, docId: string): Promise<string | null> {
  const workspace = await getPrisma().workspace.findUnique({
    where: { id: workspaceId },
    select: { slug: true, organization: { select: { slug: true } } },
  })
  return safeEntityUrl({ orgSlug: workspace?.organization?.slug, workspaceSlug: workspace?.slug, type: "doc", id: docId })
}

export async function createSpec(args: { workspaceId: string; scopeType: SpecScopeType; scopeId: string; template?: SpecTemplateVariant; label?: string }) {
  const { authorId, authorName } = documentMcpActor()
  const result = await createSpecCore(
    { workspaceId: args.workspaceId, scopeType: args.scopeType, scopeId: args.scopeId, template: args.template, label: args.label },
    { userId: authorId ?? null, authorName, source: "MCP" },
  )
  if (!result.ok) {
    return fail(result.error === "scope_not_found" ? scopeNotFoundMessage(args.scopeType) : "Could not link the new spec to its scope; nothing was created. Try again.")
  }
  const [node, url] = await Promise.all([docFs.resolveById(args.workspaceId, result.docId), docUrl(args.workspaceId, result.docId)])
  const kind = args.scopeType === "SOLUTION" ? "Spec" : "Discovery Plan"
  const text = [
    `**${kind} created**`,
    `ID: ${result.docId}`,
    `Title: ${result.title}`,
    ...(node ? [`Path: ${node.path}`] : []),
    `Scope: ${args.scopeType} ${result.scopeId}`,
    ...(url ? [`URL: ${url}`] : []),
  ].join("\n")
  return ok(text, {
    id: result.docId,
    title: result.title,
    path: node?.path ?? null,
    docType: "SPEC",
    scopeType: result.scopeType,
    scopeId: result.scopeId,
    linkId: result.linkId,
    template: result.template,
    label: result.label,
    url,
  })
}

export async function listSpecs(args: { workspaceId: string; scopeType: SpecScopeType; scopeId: string }) {
  const specs = await listSpecDocs(args)
  if (!specs) return fail(scopeNotFoundMessage(args.scopeType))
  if (specs.length === 0) return ok("No specs for this scope.", { items: [], count: 0 })
  const nodes = await docFs.listPaths(args.workspaceId)
  const pathById = new Map(nodes.map((node) => [node.docId, node.path]))
  const items = await Promise.all(
    specs.map(async (spec) => ({
      id: spec.id,
      title: spec.title,
      path: pathById.get(spec.id) ?? null,
      label: spec.label,
      updatedAt: spec.updatedAt.toISOString(),
      url: await docUrl(args.workspaceId, spec.id),
    })),
  )
  const lines = items.map((item) => `• ${item.title}${item.label ? ` [${item.label}]` : ""} — ${item.path ?? "(no path)"} — updated ${item.updatedAt} — doc ID: ${item.id}`)
  return ok(lines.join("\n"), { items, count: items.length })
}
