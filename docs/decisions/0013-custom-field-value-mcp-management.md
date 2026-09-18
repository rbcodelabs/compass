# ADR 0013 — MCP Read/Write Access to Custom Field Values

- **Status:** Accepted
- **Date:** 2026-09-17
- **Scope:** Add the smallest authenticated MCP capability needed to read a
  workspace's custom field definitions and read/write an object's custom
  field values. This decision does not let MCP create, edit, or delete a
  `CustomFieldDefinition` or a `SharedFieldOptionSet`, and does not change the
  data model.

## Context

Compass has had a Custom Fields UI (Settings → Custom Fields, plus per-object
editors on Opportunities, Solutions, Experiments, Objectives, Key Results,
Roadmap Items, and Tasks) for some time, but the MCP catalog has never had a
single tool for it. An agent working through MCP can create and update every
one of those seven entity types, but cannot see or set the workspace's own
custom attributes on them.

A `CustomFieldDefinition` is scoped to a workspace and one `objectType`
(`OPPORTUNITY | SOLUTION | EXPERIMENT | OBJECTIVE | KEY_RESULT | ROADMAP_ITEM |
TASK`), and carries either its own `options` (for SELECT/MULTI_SELECT) or a
link to a shared `SharedFieldOptionSet`. `lib/custom-field-definitions.ts`
already exposes the single read boundary that resolves a field's *effective*
options regardless of which source they came from
(`loadCustomFieldDefinitions`, `loadCustomFieldsForObject`,
`toCustomFieldDefinitionData`); this ADR reuses it rather than re-deriving it.

A `CustomFieldValue` is scoped to `(fieldId, objectId)` with a unique
constraint on that pair and **no independent `workspaceId` column** — its
workspace is only reachable by following `fieldId` back to its
`CustomFieldDefinition`. That matters for authorization: the existing MCP
gate (`assertEntityAccess`) only ever validates the *object* side
(`objectType` + `objectId`) against `WORKSPACE_ENTITY_RESOLVERS`. It has no
way to know that a caller-supplied `fieldId` even exists, let alone that it
belongs to the same workspace and the same `objectType` as the object being
written to. Without an explicit additional check, a member of workspace A
could point a legitimate object they own at a field definition belonging to
workspace B (which they may not even be a member of), or at a field defined
for a different object type in their own workspace — neither of which the
gate would catch, because it never inspects `fieldId`.

There is also currently **no server-side validation of a custom field value's
type anywhere in the codebase**. The Settings UI and per-object editors only
constrain input by rendering a type-appropriate widget (a date picker for
DATE, a picklist for SELECT, etc.) — the write path itself
(`upsertFieldValue` in `app/[orgSlug]/[workspaceSlug]/settings/actions.ts`)
accepts whatever `CustomFieldValue` it's given. An MCP caller sends raw JSON,
not a widget, so this ADR adds that validation as new behavior rather than
mirroring something that already existed.

## Decision

Add three dedicated MCP tools, all gated fail-closed like every other tool in
the catalog (`lib/mcp-tool-gates.ts`), backed by handlers in the new
`lib/custom-field-tool-handlers.ts`:

- **`list_custom_field_definitions({ workspaceId, objectType? })`** — READ.
  Gate: `assertWorkspaceMember`. Delegates straight to
  `loadCustomFieldDefinitions`; no new query logic.
- **`get_custom_field_values({ objectType, objectId })`** — READ. Gate:
  resolve `objectType` to one of the 7 already-existing `WorkspaceEntityType`s
  (`CUSTOM_FIELD_ENTITY`, e.g. `ROADMAP_ITEM → "roadmapItem"`) and run
  `assertEntityAccess` on it, exactly like every other object-scoped read.
  Delegates to `loadCustomFieldsForObject`.
- **`set_custom_field_value({ objectType, objectId, fieldId, value })`** —
  WRITE. Same object-scoped gate as `get_custom_field_values`. The handler
  then, before writing anything:
  1. Loads the `CustomFieldDefinition` row for `fieldId` (with its
     `sharedOptionSet` joined, exactly as the read boundary does).
  2. Rejects if `fieldRow.workspaceId !== workspaceId` (the object's
     resolved workspace) — the cross-tenant guard described in Context.
  3. Rejects if `fieldRow.objectType !== objectType` — the cross-objectType
     guard.
  4. Validates `value` against the field's type with a new, independently
     unit-tested `validateValueForFieldType(fieldType, options, value)`:
     `TEXT`/`URL` require a string or null; `NUMBER` a finite number or null;
     `BOOLEAN` a boolean or null; `DATE` a `Date.parse`-able string or null;
     `SELECT` one of the field's effective option values or null;
     `MULTI_SELECT` an array where every entry is one of those values, or
     null. Every failure names the offending value and, for picklists, the
     actual allowed list, so an agent can self-correct from the error text
     alone without a second round trip.
  5. Applies the exact same clearing rule `upsertFieldValue` already uses —
     `value === null || value === "" || (Array.isArray(value) &&
     value.length === 0)` deletes the row; anything else upserts on the
     `(fieldId, objectId)` unique key. This is deliberately not reinvented:
     diverging here would make the same value clear through one surface and
     silently persist through the other.

The gate for `get_custom_field_values`/`set_custom_field_value` only ever
resolves `objectId`'s workspace via `resolveEntityWorkspaceId` (a new,
membership-free export added to `lib/mcp-authz.ts` for exactly this reuse
case — the gate already ran `assertEntityAccess` once and the handler needs
the same `workspaceId` again). It does not, and structurally cannot, gate on
`fieldId`, because `assertEntityAccess`'s resolver map has no entry for a
custom field definition and adding one would be the wrong shape (a
definition is workspace + objectType scoped, not itself a workspace-owned
child of the object). The cross-tenant/cross-objectType check therefore has
to live in the handler, and it runs unconditionally before either read of
`CustomFieldValue` — i.e. before any write.

Definitions and shared option sets stay UI-only. MCP can enumerate and read
them, and read/write the values that point at them, but cannot create, edit,
or delete either.

## Options Considered

| Option | Benefits | Costs |
|---|---|---|
| **3 dedicated tools** (list definitions / get values / set one value) — chosen | Mirrors the existing per-domain tool shape (e.g. `update_solution_status`, `assign_squad`); each tool's input schema is exactly what it needs; the write path is the smallest possible surface to validate and gate | An agent setting many fields at once makes one call per field |
| A single generic get/set tool with a discriminated `mode` | Fewer registered tools | Buries two very different authorization/validation paths (a pure read vs. a type-validated write) behind one schema; harder to write a precise Zod input shape or a precise tool description |
| A bulk multi-field setter (`{ objectId, values: [{fieldId, value}, ...] }`) | One call to retag several fields on the same object | Partial-failure semantics (what happens when field 3 of 5 fails validation?) are exactly the kind of new invariant this ADR is trying to avoid inventing; no current caller need justifies the complexity yet |

## Consequences

An agent can now discover what a workspace's objects can be tagged with and
read/write those tags without any human touching Settings. Definitions and
option sets remain a deliberately manual, low-frequency admin action. Because
`set_custom_field_value` validates against the field's *currently* defined
options, a value that was valid when written can still become invalid to
re-write later if an admin has since removed that option from the field (or
its shared set) — existing stored values are never retroactively touched,
only new writes are checked.

## Risks and Revisit Triggers

The main risk is scope creep pressure: the natural next ask is "let MCP create
a custom field" or "let MCP manage a shared option set," and this ADR
deliberately does not do either. That boundary is intentional, not an
oversight — definitions change a workspace's schema-like structure and are
rare/administrative, unlike the object values themselves. Revisit this
decision (with a new ADR, not a quiet expansion of these three tools) if an
agent workflow genuinely needs to define new fields or option sets on its
own, or if `set_custom_field_value`'s single-field shape becomes a measured
bottleneck for a workflow that legitimately needs to retag many fields on one
object atomically.
