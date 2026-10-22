/**
 * Handlers for the Spec MCP tools: create_spec and list_specs (spec docs phase 2) and get_spec (phase 3).
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
import { listScopesForDoc, type SpecScopeType } from "@/lib/spec-docs/scopes"
import { specKindLabels, humanizeStatus } from "@/lib/spec-docs/labels"
import { resolveDocEmbeds, type DocEmbedCardView } from "@/lib/canvas-card-data"
import { parseDocEmbeds, type DocEmbedForm, type DocEmbedRef } from "@/lib/doc-embeds"
import { safeMatter } from "@/lib/safe-matter"
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

/** Embeds a single get_spec read will resolve; a bigger doc reports how many it left out. */
const MAX_EMBEDS_PER_READ = 500
/** Safety stop for the resolve loop (500 refs at 100 per request is 5 rounds). */
const MAX_RESOLVE_ROUNDS = 10
const SPEC_NOT_FOUND = "Spec not found in this workspace."

type EmbedReadout = { kind: string; id: string; form: DocEmbedForm } & (
  | { state: "ok"; title: string; status: string | null; facts: { label: string; value: string }[]; href: string }
  | { state: "unavailable" }
)

/**
 * A resolved read of one SPEC doc: the markdown (exactly what the docs:// resource and write_doc round-trip, frontmatter included) plus the
 * LIVE title, status and key facts of every record it embeds, and an explicit list of the references that could not be resolved. The
 * cached title in each `[title](compass://kind/uuid)` link is a hint and is never reported. Uses the same resolver as the UI, scoped to the
 * workspace of the DOC; a missing doc, one in another workspace and one that is not a spec all fail with the same message.
 */
export async function getSpec(args: { workspaceId: string; docId?: string; path?: string }) {
  if (!args.docId && !args.path) return fail("Provide docId or path.")
  // docId wins when both are given.
  const node = args.docId ? await docFs.resolveById(args.workspaceId, args.docId) : await docFs.resolvePath(args.workspaceId, args.path as string)
  if (!node || node.docType !== "SPEC") return fail(SPEC_NOT_FOUND)
  const read = await docFs.readDocById(args.workspaceId, node.docId)
  if (!read) return fail(SPEC_NOT_FOUND)

  const body = safeMatter(read.content).content
  const found = new Map<string, { ref: DocEmbedRef; form: DocEmbedForm }>()
  for (const segment of parseDocEmbeds(body).segments) {
    if (segment.type !== "embed") continue
    const key = `${segment.kind}:${segment.id.toLowerCase()}`
    const known = found.get(key)
    // A reference used as a card anywhere in the doc is reported as a card.
    if (!known || (known.form === "inline" && segment.form === "block")) found.set(key, { ref: { kind: segment.kind, id: segment.id.toLowerCase() }, form: segment.form })
  }
  const all = [...found.values()]
  const wanted = all.slice(0, MAX_EMBEDS_PER_READ)

  const { authorId } = documentMcpActor()
  const cards = new Map<string, DocEmbedCardView>()
  let remaining: DocEmbedRef[] = wanted.map((entry) => entry.ref)
  for (let round = 0; remaining.length > 0 && round < MAX_RESOLVE_ROUNDS; round++) {
    const resolution = await resolveDocEmbeds({ docId: node.docId, userId: authorId ?? "", refs: remaining, expectedWorkspaceId: args.workspaceId })
    if (!resolution) return fail(SPEC_NOT_FOUND)
    for (const [key, card] of Object.entries(resolution.cards)) cards.set(key, card)
    remaining = resolution.deferred
  }

  const embeds: EmbedReadout[] = wanted.map(({ ref, form }) => {
    const card = cards.get(`${ref.kind}:${ref.id}`)
    if (!card || card.state === "unavailable") return { kind: ref.kind, id: ref.id, form, state: "unavailable" }
    return { kind: ref.kind, id: ref.id, form, state: "ok", title: card.title, status: card.status, facts: card.facts, href: card.href }
  })
  const unavailable = embeds.filter((embed) => embed.state === "unavailable").map(({ kind, id }) => ({ kind, id }))

  const scopes = await listScopesForDoc(getPrisma(), args.workspaceId, node.docId)
  const kinds = specKindLabels(scopes.map((scope) => scope.scopeType))
  const url = await docUrl(args.workspaceId, node.docId)
  const omitted = all.length - wanted.length

  const lines = [
    `**${kinds.join(" / ")}: ${node.title}**`,
    `ID: ${node.docId}`,
    `Path: ${node.path}`,
    ...(url ? [`URL: ${url}`] : []),
    ...scopes.map((scope) => `Scope: ${scope.scopeType} ${scope.scopeId}`),
    "",
    `Embedded records (live): ${embeds.length - unavailable.length} of ${embeds.length} available`,
    ...embeds.flatMap((embed) =>
      embed.state === "ok"
        ? [`• [${embed.kind}] ${embed.title}${embed.status ? ` — ${humanizeStatus(embed.status)}` : ""}${embed.facts.length ? ` — ${embed.facts.map((f) => `${f.label}: ${f.value}`).join("; ")}` : ""} — ${embed.id}`]
        : [],
    ),
    ...(unavailable.length ? ["", "Unavailable (missing, deleted or not accessible):", ...unavailable.map((u) => `• ${u.kind} ${u.id}`)] : []),
    ...(omitted > 0 ? ["", `${omitted} more embedded records were not resolved (limit ${MAX_EMBEDS_PER_READ} per read).`] : []),
    "",
    "--- markdown ---",
    read.content,
  ]
  return ok(lines.join("\n"), {
    id: node.docId,
    title: node.title,
    path: node.path,
    docType: "SPEC",
    kinds,
    scopes,
    revision: read.revision,
    url,
    markdown: read.content,
    embeds,
    unavailable,
    omitted,
  })
}
