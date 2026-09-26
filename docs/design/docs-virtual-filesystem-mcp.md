# Implementation spec: Docs as a virtual filesystem

Companion to **ADR 0019 — Docs as a Virtual Filesystem** (Compass Doc, workspace
`rbcodelabs/compass`, child of *Architecture Decisions*
[57218788-1db1-4148-b954-b98fb7055c62]). That ADR carries the decision and
consequences; this document carries the mechanics an engineer needs to build
it. See the note at the end of this file ("Why this lives in the repo, not
Compass Docs") for where the line between the two documents was drawn.

Status: draft, not yet implemented. Nothing in this document has shipped.

---

## 1. `lib/doc-fs.ts` — the shared layer

```ts
export type DocFsNode = {
  path: string          // e.g. "Product/Roadmap/Q3 Plan"  (no extension)
  docId: string
  title: string
  parentId: string | null
  roadmapItemId: string | null
  docType: "STANDARD" | "GTM_POSITIONING_BRIEF"
  hasChildren: boolean
  updatedAt: Date
}

listPaths(workspaceId: string): Promise<DocFsNode[]>
readPath(workspaceId: string, path: string): Promise<{
  docId: string; content: string /* frontmatter + body */; revision: string | null
} | null>
writePath(workspaceId: string, path: string, content: string, opts: {
  operationId?: string; expectedRevision?: string; authorId?: string | null; authorName: string
}): Promise<{ docId: string; created: boolean; revision: string | null; path: string }>
deletePath(workspaceId: string, path: string, opts: {
  recursive?: boolean; operationId?: string; expectedRevision?: string; authorName: string
}): Promise<void>
movePath(workspaceId: string, fromPath: string, toPath: string, opts: {
  operationId?: string; expectedRevision?: string; authorName: string
}): Promise<{ docId: string; revision: string | null }>
```

None of these touch Prisma directly for mutations. They resolve `path` to a
`docId` (or, for `writePath` on a path that doesn't resolve, to a
parent-doc-id-plus-title), then call straight through to the **existing**
abstraction in `lib/document-service.ts`: `createDocument`, `updateDocument`,
`deleteDocument`, `hydrateDocument`, `restoreDocument`. That module already
branches on `Doc.storageProvider` (`DATABASE` vs `GEODE`) and already owns
idempotent-retry (`DocOperation` receipts, keyed on `operationId` +
payload digest) and optimistic concurrency (`expectedRevision` vs
`Doc.revision`) for the Geode pilot. `doc-fs.ts` adds no second copy of that
logic — it is a path-addressed *view* over the same id-addressed mutation
functions the existing `create_doc`/`update_doc` handlers already call. This
is also exactly why `doc-fs.ts` works unchanged whether a given `Doc` row's
content lives in the DB `content` column or behind the Geode blob reference,
and would keep working unchanged if that pilot generalizes beyond one
workspace later (out of scope here; see ADR 0018 in Compass Docs) — the
branch point already lives in `document-service.ts`, not in anything this
design adds.

### 1.1 Path encoding

**A path segment is the doc's title, lightly sanitized — not a slugified
lowercase string.** Filesystem-illegal characters (`/ \ : * ? " < > |` and
control characters) are replaced with `_`; leading/trailing whitespace and
trailing dots are trimmed; length is capped at 200 bytes (truncate, don't
error — a 200-byte title is already a UX problem the doc editor should catch,
not something this layer should reject on).

This was a deliberate reversal of the more obvious "slugify like a URL"
approach. A slug (`q3-plan`) is lossy: recovering the original title
`"Q3 Plan!"` from it on a rename requires either a side-table or accepting
that renames-via-filesystem never round-trip case or punctuation. Using the
lightly-sanitized title as the path segment makes "the file/directory name
*is* the title" a lossless, bidirectional fact, matching how a human managing
a folder of Markdown files already thinks (Obsidian, Notion export, Logseq
all do the same thing) — and it means the coding agent sees titles it
recognizes instead of URL-shaped slugs.

**Collision handling.** `Doc.title` has no uniqueness constraint, and nothing
stops two sibling docs sharing a title today. `listPaths` walks siblings in a
stable order (`sortOrder asc, createdAt asc, id asc`) and appends
`" (<first 8 hex chars of docId>)"` to every sibling after the first one that
collides on the sanitized title. This is recomputed on every materialization,
not stored — a doc that stops colliding (its sibling was renamed or moved)
goes back to a bare path next turn without needing a migration.

### 1.2 One doc = one directory (not "leaf file vs. folder-with-index")

**Every doc is materialized as a directory `<path-segment>/` containing
exactly one file, `_doc.md`, plus zero or more subdirectories — one per
child doc.** A doc with zero children is still a directory containing only
`_doc.md`.

This was the least obvious call in this design and is worth stating why the
alternative was rejected. The more "natural-looking" scheme is:
leaf docs are a plain `<title>.md` file; only docs *with* children get a
directory containing an `_index.md`/`_doc.md`. It reads better in a file
tree at a glance. It was rejected because it makes a doc's on-disk shape
depend on a fact that changes during normal use — the moment a leaf doc
gains its first child (an agent adds a subdoc under something that used to
be childless), its own content file has to *move* from `<title>.md` to
`<title>/_doc.md` in the same turn as the child is created, and the
reconciler has to detect that a rename and a directory-creation happened
atomically together. That coupling is exactly the kind of ambiguity this
design otherwise goes out of its way to avoid (see §2). Paying a small,
constant cost — every doc is a directory, even childless ones — buys a
single uniform rule with no mode-switch. A workspace with a few hundred docs
means a few hundred small directories; this is not a scale problem.

Root-level docs live directly under the sandbox's docs root, e.g.
`<DOCS_ROOT>/Product/_doc.md`, `<DOCS_ROOT>/Product/Roadmap/_doc.md`.

### 1.3 `_doc.md` contents

```markdown
---
compass_doc_id: 3f9a2b10-....
compass_doc_type: STANDARD
compass_roadmap_item_id: 8b21....       # omitted if null
status: draft                            # ordinary user metadata, passthrough
owner: rick                              # ordinary user metadata, passthrough
---
# The doc's actual markdown content starts here.
```

This is the *same* `gray-matter` round-trip `lib/doc-tool-handlers.ts` already
does for `Doc.metadata` (`parseContent` / `serializeWithFrontmatter`) — `doc-fs`
reuses those two functions verbatim. It adds one rule on top: keys prefixed
`compass_` are a reserved namespace, stripped before the remainder is stored
in `Doc.metadata`, and re-injected on every `readPath`. `compass_doc_id` is
never accepted from a client write if it disagrees with the doc the write is
targeting (see §2.4) — it is provenance, not an input.

`compass_revision` is deliberately **not** written into the frontmatter body.
Revision is carried out-of-band (see §2.1) so an agent's ordinary
find-and-replace editing of the visible content can never accidentally
corrupt the concurrency token.

---

## 2. Sandbox reconciliation (Projection 1 — in-app agent)

This is the part flagged as unsolved going in. The core idea that resolves it:

> **Identity is carried by an opaque id embedded in the file, never inferred
> from path or content similarity.** A file that disappears from path A and
> reappears (by `compass_doc_id`) at path B is a move, full stop — no
> heuristic scoring of "these look like the same file" is needed or wanted.
> Content-similarity heuristics (the kind generic folder-sync tools use) were
> considered and rejected: they degrade exactly when an agent does the two
> things it's most likely to do — move a doc *and* substantially rewrite it
> in the same turn, or produce two docs with near-identical starter content.

### 2.1 Extending optimistic concurrency to non-Geode docs (a real gap this design has to close)

`document-service.ts`'s `updateDocument` today enforces `expectedRevision`
**only** when `doc.storageProvider === "GEODE"`. A plain DB-backed doc (the
overwhelming majority of docs today — Geode is a single-workspace pilot) goes
through `db.$transaction(tx => { snapshot(...); tx.doc.update(...) })` with
**no revision check at all**. That is last-write-wins today, by design, for
the UI's autosave.

The brief's requirement — a revision conflict "must surface as an explicit,
visible error, never a silent overwrite" — is not satisfiable for the common
case without closing this gap, so this design proposes closing it as part of
the same change:

- `document-service.ts` stamps a fresh `Doc.revision` (UUID) on **every**
  mutation, regardless of `storageProvider`.
- `updateDocument`/`deleteDocument` perform the same
  `tx.doc.updateMany({ where: { id, revision: expectedRevision }, ... })`
  guard for DB-backed docs **whenever the caller supplies `expectedRevision`**
  — but do not require it. A caller that omits `expectedRevision` (today's UI
  autosave, today's legacy MCP handlers, until they're migrated) keeps
  exactly today's last-write-wins behavior. This is additive, not breaking.
- `doc-fs.ts` is the first caller that *always* supplies `expectedRevision`
  on every mutating path it drives from sandbox reconciliation, because it is
  the first caller for whom losing a concurrent edit is genuinely
  unacceptable — a background agent turn can run for minutes, long enough for
  a human to be actively editing the same doc in the UI at the same time.

This is a real, non-trivial change to `document-service.ts`, not a config
flag. It should land as its own reviewed unit before `doc-fs.ts` is built on
top of it.

### 2.2 Sandbox tool configuration (`scripts/agent/turn-entry.ts`)

Today (verified against this file on `origin/main`):

```ts
tools: [],
strictMcpConfig: true,
allowedTools: ["mcp__compass", ...connectorToolPrefixes],
disallowedTools: ["mcp__compass__delete_assumption", "mcp__compass__delete_solution_comment"],
permissionMode: "bypassPermissions",
allowDangerouslySkipPermissions: true,
```

**Load-bearing fact, checked against the Claude Agent SDK's current docs
(`code.claude.com/docs/en/agent-sdk/permissions`), not assumed:**
*`allowedTools` does not gate anything under `permissionMode: "bypassPermissions"`.*
The docs are explicit: `allowedTools=["Read"]` combined with
`bypassPermissions` still approves *every* tool, Bash included — only
`disallowedTools`, or omitting a built-in from `tools` entirely, actually
blocks something once permissions are bypassed. This is *why* today's config
sets `tools: []`: that is the real gate keeping Read/Write/Edit/Bash out of
this agent's hands, and `allowedTools`/`disallowedTools` are doing MCP-tool
selection on top of an already-empty built-in catalog. Any change to give
this agent real file tools has to change `tools`, not lean on `allowedTools`.

Proposed:

```ts
tools: ["Read", "Write", "Edit", "Glob"],   // Bash deliberately omitted — see §2.5
cwd: DOCS_ROOT,                              // e.g. "/vercel/sandbox/docs"
strictMcpConfig: true,
mcpServers: {
  compass: { ...unchanged... },
  docsfs: createSdkMcpServer({               // in-process, no network — see §2.3
    name: "docsfs",
    tools: [deleteLocalDocTool, moveLocalDocTool],
  }),
  ...connectors,
},
allowedTools: [
  "mcp__compass", "mcp__docsfs", "Read", "Write", "Edit", "Glob",
  ...connectorToolPrefixes,
],
disallowedTools: [
  "mcp__compass__delete_assumption", "mcp__compass__delete_solution_comment",
  // Content/structure tools superseded by native file tools for THIS agent
  // only — see §3 for why comment/history tools are NOT in this list.
  "mcp__compass__write_doc", "mcp__compass__delete_doc", "mcp__compass__move_doc",
],
permissionMode: "bypassPermissions",
allowDangerouslySkipPermissions: true,
```

`docs/decisions/0001-in-app-agent-architecture.md` (now a pointer stub to the
Compass Doc) established the sandbox-as-security-boundary model this reuses:
the microVM is disposable and per-turn, so giving it real file tools scoped
to one throwaway directory does not weaken anything the MCP-only design was
protecting.

### 2.3 Delete and move without Bash

The SDK's built-in file tools are `Read`, `Write`, `Edit`, `Glob`, `Grep` —
there is no built-in delete-file or move/rename-file tool; those live only
inside `Bash` (`rm`, `mv`). Two options were considered for expressing
"delete this doc" / "move this doc" from inside the sandbox:

| Option | How | Rejected because |
|---|---|---|
| Enable `Bash` | Add `"Bash"` to `tools` | Bash is a materially larger surface than "edit markdown files" — it can read env vars (the MCP bearer token is in `process.env`) and, if the sandbox has any open network egress, exfiltrate them somewhere Compass never intermediates. MCP-only access is deliberately intermediated through `/api/mcp`; Bash punches a hole next to it, not through it. |
| Frontmatter sentinel (e.g. `compass_delete: true`) | Agent edits a magic frontmatter key via `Edit` | Undiscoverable without a bespoke system-prompt instruction, easy for the model to forget or apply inconsistently, and it overloads a document's own content with a control channel. |

**Chosen: a small in-process SDK MCP server** (`createSdkMcpServer` +
`tool()`, confirmed present and documented in the currently-installed
`@anthropic-ai/claude-agent-sdk` API surface — this is the SDK's own
extensibility mechanism, not a bolt-on) exposing exactly two tools:

- `delete_local_doc(path)` — `node:fs` `rm -r` on `<DOCS_ROOT>/<path>`, after
  resolving and checking the real path stays under `DOCS_ROOT` (reject `..`
  traversal). **Local disk only — no network call, no DB mutation.**
- `move_local_doc(fromPath, toPath)` — `node:fs` `rename`, same
  containment check on both paths.

Critically, **these do not talk to Compass at all.** They only rearrange the
sandbox's own ephemeral disk. The actual `deleteDocument`/`movePath` call
against the DB happens in the *same* end-of-turn reconciliation pass as every
other change (§2.4) — deliberately, so there is exactly one moment where
`DocOperation` idempotency and `expectedRevision` conflict-checking apply, not
two different mutation pathways (one immediate-via-MCP, one
deferred-via-diff) with different timing and failure semantics to reason
about separately.

### 2.4 The reconciliation algorithm

**Baseline (captured by the host, in `app/api/agent/turn/route.ts`, before
`runCommand`):** for every node from `doc-fs.listPaths(workspaceId)`, call
`readPath`, and record `path → { docId, revision, sha256(fileBytes) }` in a
plain in-memory map for the lifetime of this one streaming request. Then
`sandbox.writeFiles([...])` every `_doc.md` into `<DOCS_ROOT>/<path>/_doc.md`
— this already the same primitive the route uses today to write `entry.ts`
before `runCommand`.

**Final (captured by the host, after `runCommand` resolves):** walk the
sandbox's docs root with `sandbox.fs.readdir(..., { withFileTypes: true })`
recursively and `sandbox.fs.readFile(path, "utf8")` every `_doc.md` found —
both confirmed methods on the installed `@vercel/sandbox@2.9.2`'s
`FileSystem` class. Build `path → { rawFrontmatterDocId | null, content,
sha256(fileBytes) }`.

**Validate `compass_doc_id` before trusting it.** A value is only treated as
identity if it was actually a docId this turn's baseline handed out.
Anything else — missing, malformed, or a foreign/hallucinated id an agent
copy-pasted from another file while drafting a new one — is treated as "no
id," i.e. a create. If the *same* valid id appears at more than one final
path (an agent duplicated a file including its frontmatter), the occurrence
whose path is lexically closest to the doc's baseline path wins as the
move/update; every other occurrence is persisted as a **new** doc with its
`compass_doc_id` stripped first, so two DB rows never race to claim one id.

**Diff, per baseline entry and per new final entry:**

| Observation | Action |
|---|---|
| Same docId, same path, same hash | No-op |
| Same docId, same path, different hash | `writePath` (update): `expectedRevision` = baseline revision, `operationId` = `uuid5(turnId, docId)` (deterministic — safe to retry the whole reconciliation pass) |
| Same docId, different path, same hash | `movePath` (pure rename/reparent) |
| Same docId, different path, different hash | `movePath` then `writePath` |
| docId gone from final tree entirely | `deletePath` (the containing directory disappearing means every doc nested under it is also gone — process bottom-up so a child's deletion is recorded before its parent's) |
| New path, no valid docId | `writePath` (create) — process top-down by path depth, so a new parent directory's doc is created before a new child nested inside it |

**Revision conflicts — the "never silently overwrite/never silently drop"
requirement.** If `writePath`/`movePath`/`deletePath` throws
`DocumentError("revision-conflict")` (a human changed the doc in the UI
during the turn), the reconciler does **not** retry with the newer
revision and does **not** discard the agent's version. Instead it calls
`snapshotDocument`-equivalent logic to attach the agent's would-be content as
a **labeled, non-current `DocVersion`** on the doc as it now actually stands
— label: `"Agent's conflicting edit — not applied (<timestamp>)"` — and
surfaces the conflict as an explicit line in the turn's final result text
("Couldn't save changes to '<title>' — someone else edited it while I was
working; your edit is saved in its version history for you to review or
restore."). This reuses version history, a mechanism a human already knows
how to read and restore from, rather than inventing a new side-channel
document or queue. Nothing is silently dropped (the content is durably
stored) and nothing is silently overwritten (the live doc keeps the human's
edit).

### 2.5 What this projection deliberately does not do in v1

Doc **comments** and **version history/restore** are not represented as
files at all — there is no natural, low-risk filesystem shape for "an
anchored inline comment thread" that doesn't reinvent half of `DocComment`,
and restoring a version is a point-in-time action, not a content edit. The
in-app agent keeps `mcp__compass__add_doc_comment`,
`mcp__compass__list_doc_comments`, `mcp__compass__resolve_doc_comment`,
`mcp__compass__list_doc_history`, and `mcp__compass__restore_doc_version`
available exactly as an external MCP agent does (§3) — only the
**content/structure** tools (`write_doc`, `delete_doc`, `move_doc`,
`list_docs`, `get_doc`) are superseded by native file tools for this agent,
because those are the ones with a clean, lossless filesystem equivalent.

Known edge case, documented rather than solved: if the agent calls
`restore_doc_version` via MCP mid-turn (an immediate DB mutation) and then
also edits the same doc's still-materialized (pre-restore) file via `Edit`
later in the same turn, the file-based edit at reconciliation time is applied
on top of the pre-restore content and will overwrite the just-restored
version. This mirrors ordinary "opened an old copy, kept editing, saved"
behavior a human could equally cause, and is not treated as a defect worth
solving in v1.

---

## 3. External MCP projection

### 3.1 Resources — confirmed supported, with the exact evidence

**Question the ADR needed answered before committing: does the installed
`mcp-handler` support registering resources with a listable, path-style URI
cleanly?** Verified, not assumed:

- Installed versions (from `pnpm-lock.yaml`, this repo, `node_modules` not
  present in this worktree so verified against upstream sources instead of a
  local install): `mcp-handler@1.1.0` on `@modelcontextprotocol/sdk@1.26.0`.
- `mcp-handler`'s own current docs (fetched from
  `github.com/vercel-labs/mcp-handler/blob/main/docs/ADVANCED.md` via the
  `find-docs`/context7 pipeline) confirm `createMcpHandler((server) => {...})`
  hands the callback the **raw underlying `McpServer` instance** from the
  SDK — `mcp-handler` is a transport adapter, not a capability-limiting
  wrapper — and separately document `maxSubscriptions` (resource
  subscription/listen-stream limiting) and `handler.notify.resourceUpdated(uri)`
  as first-class handler-level features. A resource-subscription notify
  facade would not exist if resources weren't supported.
- The MCP TypeScript SDK's current docs
  (`github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/resources.md`,
  matching the installed SDK's major version) confirm
  `server.registerResource(name, new ResourceTemplate(uriTemplate, { list: async () => ({ resources: [...] }) }), config, readCallback)`
  is exactly the "enumerable template" shape needed, and that registering a
  `list` callback is precisely what makes a template's concrete instances
  appear in `resources/list` (matching what an MCP client's doc-tree browser
  needs).

**Answer: supported.** No tool-pair fallback is needed.

**URI shape.** `docs://{workspaceId}/{+path}` — the `+` (reserved-expansion)
operator on `path` matters and is called out explicitly here because it is
easy to get wrong silently: a bare `{path}` in an RFC 6570 URI template
percent-encodes `/`, which would make a multi-segment doc path
un-matchable as a single variable. This is stated as a requirement, not
independently verified against the SDK's own `UriTemplate` parser in this
pass — confirm `{+path}` resolves as intended against the installed SDK
version before relying on it, as the very first thing done in implementation
(a two-line manual test: register a template with a `/`-containing path and
call `client.readResource`).

**Why the URI carries `{workspaceId}` explicitly, not implicitly from the
caller's auth context:** checked `lib/agent-access.ts`'s
`agentWorkspaceWhere` — an agent actor (in-app or external OAuth) can hold
`AgentWorkspaceGrant`s across **multiple** workspaces simultaneously. A URI
scheme that assumed one implicit workspace per connection would be wrong for
any agent with more than one grant. The `list` callback enumerates
`doc-fs.listPaths(workspaceId)` for every workspace the authenticated actor
is granted access to and concatenates the results.

### 3.2 The old-tool-to-new-tool mapping

| Old tool (15, all removed) | New surface | Notes |
|---|---|---|
| `list_docs` | `docs://{workspaceId}/{+path}` resource **list** | |
| `get_doc` | `docs://{workspaceId}/{path}` resource **read** | |
| `create_doc` | `write_doc(workspaceId, path, content, operationId?, expectedRevision?)` | create-or-update; parent directories in `path` are created implicitly |
| `update_doc` | `write_doc(...)` | same tool as create — see below |
| `create_doc_version` | *(removed)* | auto-snapshot-before-overwrite already exists (`maybeSnapshotDocVersion`); a deliberate pre-rewrite checkpoint is achievable with a trivial no-op `write_doc` first |
| `list_doc_versions` | `list_doc_history(workspaceId, path)` | |
| `get_doc_version` | *(removed)* | `restore_doc_version` doesn't need a separate fetch-then-restore round trip |
| `restore_doc_version` | `restore_doc_version(workspaceId, path, versionId)` | now path-addressed |
| `add_doc_comment` | `add_doc_comment(workspaceId, path, body, ...)` | path-addressed |
| `list_doc_comments` | `list_doc_comments(workspaceId, path, status?)` | |
| `get_doc_comment` | *(removed)* | `list_doc_comments` already returns full bodies; redundant |
| `update_doc_comment` | *(removed)* | already `DENY`-gated for every actor in `lib/mcp-tool-gates.ts` today — removing it is zero regression, it is dead capability right now |
| `delete_doc_comment` | *(removed)* | destructive, cascades to replies, no undo — matches the existing "Phase 5" posture in `scripts/agent/turn-entry.ts` that already keeps two other hard-deletes out of agent reach by default; adding a third hard-delete to the *smaller* replacement surface would be a step backward |
| `resolve_doc_comment` | `resolve_doc_comment(workspaceId, path, commentId, resolved?: boolean = true)` | `resolved: false` subsumes `reopen_doc_comment` — the handlers already only flip one `status` field between `OPEN`/`RESOLVED`, so this is a parameter, not a feature |
| `reopen_doc_comment` | *(removed — see above)* | |
| `prepare_doc_image_upload` | **unchanged, untouched** | not one of the 15 in scope; returns an upload URL/token for a raster image, which has no meaningful filesystem-content representation |

Net: 15 tools → 8 tools (`write_doc`, `delete_doc`, `move_doc`,
`list_doc_history`, `restore_doc_version`, `add_doc_comment`,
`list_doc_comments`, `resolve_doc_comment`) + 2 resource operations (list,
read) + `prepare_doc_image_upload` unchanged.

`write_doc` deliberately does not split into separate create/update tools —
`path` already tells you which one it is (an external agent doing `write_doc`
on a path it just listed is updating; on a path it invented is creating),
mirroring the collapse `document-service.ts` already does internally.

`delete_doc(workspaceId, path, recursive?: boolean = false)` — refuses (with
a clear message, "doc has N children; pass recursive: true") to delete a doc
with children unless `recursive` is set, matching Unix `rmdir` vs `rm -r`
rather than defaulting to the more dangerous behavior.

`move_doc(workspaceId, fromPath, toPath)` — handles rename (same parent, new
title) and reparent (new parent) uniformly, since both are just "the path
changed."

### 3.3 Authorization

Every new tool and every resource read/list still routes through
`lib/mcp-authz.ts`. Because these are path-addressed rather than
id-addressed, they resolve `workspaceId` directly from the input (already
present in every call) and call `assertWorkspaceMember`/`assertAgentWorkspaceAccess`
the same way `list_docs`/`create_doc` already do today — there is no id to
resolve-then-check the way `assertEntityAccess` does for the old
`docId`-keyed tools. `lib/mcp-tool-gates.ts`'s allow/deny tables get updated
to reference the 8 new tool names in place of the 15 old ones; the
READ/MUTATE split carries over directly (`list_doc_history`,
`list_doc_comments`, resource list/read → READ; `write_doc`, `delete_doc`,
`move_doc`, `add_doc_comment`, `resolve_doc_comment` → MUTATE).

---

## 4. Rollout and verification plan

**Order of work** (each is independently reviewable):

1. Extend `document-service.ts`'s optimistic concurrency to all docs (§2.1).
   Verify: existing Geode-pilot tests still pass; add a test that a
   DB-backed doc update with a stale `expectedRevision` now throws
   `revision-conflict` where before it silently succeeded.
2. Build `lib/doc-fs.ts` and its unit tests (path encoding/collision, tree
   walk, frontmatter round-trip) against `lib/doc-tool-handlers.ts`'s
   existing test fixtures where they overlap.
3. Register the 8 new tools + `docs://` resources in `app/api/mcp/route.ts`,
   remove the 15 old ones, update `lib/mcp-tool-gates.ts`. Update
   `docs/content/09-mcp-api.md`'s "Docs" and "Doc inline comments" sections
   (customer-facing; not done as part of this doc, called out here so it
   isn't forgotten at merge time).
4. Wire Projection 1: materialize/reconcile in `app/api/agent/turn/route.ts`,
   the `tools`/`mcpServers` change in `scripts/agent/turn-entry.ts`, the
   `docsfs` in-process server.

**"Done" looks like, verified how:**

- *External MCP projection:* connect an MCP client (e.g. Claude Desktop, per
  the existing "Example: Connecting Claude Desktop" section of
  `docs/content/09-mcp-api.md`) to a test workspace. `resources/list` returns
  every doc as a `docs://` URI; reading one returns frontmatter + body
  matching `get_doc`'s old output shape. `write_doc` on a new path creates a
  doc visible in the Compass UI at the right place in the tree; `move_doc`
  reparents it and the UI tree reflects the move; `delete_doc` without
  `recursive` on a doc with children fails with the documented message.
- *In-app agent projection:* trigger a turn against a workspace with an
  existing multi-level doc tree, instruct the agent (via prompt) to edit one
  doc's content, create a new child doc under another, and rename a third.
  After the turn, confirm via the Compass UI (not just the sandbox log) that
  all three land correctly with correct parentage — then, separately, start
  a second turn, and *while it is running*, edit one of the docs it
  materialized through the UI directly; confirm the turn's own attempted
  write to that doc surfaces as an explicit conflict in its final message
  and that a labeled "Agent's conflicting edit — not applied" version exists
  in that doc's history afterward, not a silent loss in either direction.

---

## Why this lives in the repo, not Compass Docs

This repo's own `CLAUDE.md` and `docs/decisions/README.md` state, as of the
2026-09-19 migration (and reinforced after two further violations, see ADR
0016 and the 0017-Compass-GitHub-App draft in Compass Docs): **Compass Docs,
not `docs/decisions/`, is now the system of record for architecture
decisions.** `ADR 0019 — Docs as a Virtual Filesystem` was created as a child
Doc of *Architecture Decisions*
(`https://compass.rbcodelabs.com/rbcodelabs/compass/docs/57218788-1db1-4148-b954-b98fb7055c62`)
and routed for review via `request_decision`, per that convention — not
written as a new file under `docs/decisions/` here, which would have been a
fourth instance of the exact mistake that README already documents twice.

This document is a **design/implementation spec**, not the decision record
itself, and `docs/design/` (unlike `docs/decisions/`) carries no such
restriction — it already holds comparable implementation-detail documents
(`agent-scoped-oauth.md`, `mcp-oauth-discovery.md`, etc.) alongside their
Compass-Docs-hosted ADRs. It is committed here, in the repo, because an
engineer implementing this will be reading it next to the source it
describes, not in Compass.
