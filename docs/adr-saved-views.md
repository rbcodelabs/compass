# ADR-0018 (proposed): Generic saved views with board column layout

**Date:** 2026-10-21
**Status:** Proposed. Per CLAUDE.md, Compass Docs is the authoritative home for ADRs and `docs/decisions/` takes pointer stubs only. This file is a working draft: on review, create it as a child Doc under "Architecture Decisions" and route it with `request_decision` (`subjectType: "DOC"`). Approval must come back from the provider; do not mark it Accepted here.
**Scope:** design only. No implementation code.

Note: `Claude/repo-map.md` does not exist in this worktree and `AGENTS.md` only carries the Next.js warning block. This design is grounded in a direct read of the files cited below. Read `node_modules/next/dist/docs/` before implementing any page or server-action change.

## 1. Context

`RoadmapView` (`prisma/schema.prisma:3691`, table `roadmap_views`, migration `079`) stores a named snapshot of roadmap filters and display options. It has `PERSONAL`/`SHARED` visibility, a nullable `workspace_id` (NULL means the org-level roadmap), and two zod-validated JSON columns, `filters` and `display`. The pieces around it:

- `lib/roadmap-views/{schema,access,service,workspace,query,group}.ts`
- `app/[orgSlug]/roadmap/actions.ts` (create/update/delete)
- `components/roadmap/cross-workspace/saved-views-menu.tsx` (picker, save, rename, delete) and `components/roadmap/workspace-saved-views.tsx`

The URL is the live state. `?saved=<id>` selects a view, explicit params override it, and `edited=1` means "the URL carries the full state, do not layer the view under it".

The Opportunities board (`discovery/page.tsx`, `components/discovery/opportunity-board.tsx`) and the Solutions backlog (`solutions/page.tsx`, `components/solutions/solution-backlog-board.tsx`) keep `view`, `groupBy`, `sort`, `squad`, `field` and `fieldValue` in the URL only. Nothing can be saved. Column order is hard-coded: a `COLUMNS` array in `opportunity-board.tsx` with Active first, then Prioritized, Validating, Exploring. There is no per-user order and no way to hide a column.

### Decisions already made (not re-litigated here)
1. Generalize across Opportunities, Solutions and Roadmap. Not Opportunities-only.
2. With no saved view, the default column order stays Active, Prioritized, Validating, Exploring.
3. A saved order that is missing a status appends the missing columns.
4. A hidden column that still has cards is shown anyway.

### Constraints
- Two backends exist (plain Postgres/Supabase for rbcodelabs production, Aurora DSQL for the work deployment). Design to the stricter DSQL rules so one migration serves both. Per the comments in migration 079: no foreign keys, one DDL statement per statement, `CREATE INDEX ASYNC`, no triggers. A migration needs a postcondition checker in `lib/migrations/` and a runner entry.
- Rolling deploys: old and new code run against the same table for a while, so schema changes must be expand/contract.
- Existing `?saved=<id>` links must keep working, so row ids are preserved.
- `@dnd-kit/core` and `@dnd-kit/sortable` are already in the boards for card drag. No new dependency.

### Riskiest assumption
People want to save column order and hidden columns as a view. If order is really a team convention ("our board reads left to right by stage"), personal views solve the wrong problem and shared views matter more than this ADR assumes. See section 4.

## 2. Data model

### Options

| Option | Pros | Cons |
|---|---|---|
| A. Extend `roadmap_views` in place: add nullable `surface`, keep `filters` and `display` JSON, rename only the Prisma model to `SavedView` with `@@map("roadmap_views")` | Rolling-deploy safe. Ids preserved. No row copy. One additive column. Column layout lives in `display`, where it belongs. | Table name is a legacy misnomer. `surface` stays nullable, because DSQL may not support `SET NOT NULL`, so non-null is an application invariant. |
| B. New `saved_views` table, copy rows, cut over | Clean name and constraints | Dual-write or downtime window. Copy plus cut-over risk for a table that has about no rows. Two sources of truth during the transition. |
| C. One table per surface | Strong typing per table | N tables, N services, and a picker that no longer generalizes. Defeats the goal. |

**Recommendation: A.** The only thing that is truly new is "which surface does this row belong to". Everything else (filters, display, visibility, owner) already exists.

### Prisma (illustrative)

```
model SavedView {            // @@map("roadmap_views")  -- table name unchanged on purpose
  id, organizationId, workspaceId?, ownerId, name, visibility,
  surface   String?  @db.VarChar(40)   // null = legacy row, derive from workspaceId
  filters   Json     @default("{}")    // per-surface zod schema
  display   Json     @default("{}")    // per-surface zod schema, includes column layout
  createdAt, updatedAt
  @@index([organizationId, workspaceId, surface], map: "idx_roadmap_views_org_surface_kind")
}
```

`surface` values:

- `OPPORTUNITIES_BOARD`
- `SOLUTIONS_BOARD`
- `ROADMAP_WORKSPACE`
- `ROADMAP_ORG`

Workspace-scoped surfaces require `workspaceId` non-null. `ROADMAP_ORG` requires it null. Both are enforced in service code.

Name uniqueness is checked in the service (per owner, surface and workspace). No unique index, to avoid DSQL async-unique complexity. The existing cap of 50 views per owner per surface stays.

### Migration plan (expand, then contract)

1. **Migration 098_saved_views_surface** (additive, expand only):
   - `ALTER TABLE roadmap_views ADD COLUMN IF NOT EXISTS surface VARCHAR(40)`, as its own statement. Verify on DSQL that a nullable column with no default is accepted, which it should be.
   - `CREATE INDEX ASYNC IF NOT EXISTS idx_roadmap_views_org_surface_kind ON roadmap_views(organization_id, workspace_id, surface)`.
   - Idempotent batched backfill, written as a data step in `lib/migrations/` (the 093/094 backfill pattern):
     - `workspace_id IS NULL` becomes `ROADMAP_ORG`
     - otherwise `ROADMAP_WORKSPACE`
     - only where `surface IS NULL`
   - Postcondition checker following `assertRoadmapViewsMigration`: the column exists and is nullable, the index is valid and ready, and no `NULL` surface remains. Register it in `lib/migrations/runner.ts`. Extend `__tests__/roadmap-views-migration.test.ts` and `__tests__/prisma-migrations.test.ts`.
2. **Code tolerates NULL.** Read as `surface ?? derive(workspaceId)`. Writes always set `surface`. A row written by old code mid-rollout is covered by this read fallback, so no race.
3. **Contract (later, optional):** once no NULL remains for a release, drop the fallback. Renaming the table is explicitly not planned.

Existing roadmap `filters` and `display` documents are untouched. The current roadmap zod schemas become the `ROADMAP_*` per-surface schemas unchanged, except for the optional `columns` field added in section 3. No document rewrite is needed, which is the main reason for choosing A.

## 3. Per-surface config schemas

A registry `SURFACES[surface]` supplies: `filtersSchema`, `displaySchema`, defaults, URL param map, whether sharing is enabled, and the column keys for the current grouping. Reads use the existing never-throw `parseStored*` pattern, so a stale document degrades to the default.

### Column layout (shared building block)

```
columnLayout   = { order: string[] (max 50), hidden: string[] (max 50) }
display.columns = Record<groupKey, columnLayout>
```

`groupKey` is `"status"` or a custom-field id.

Layouts are keyed by grouping because the board can be grouped by status or by a custom field (`resolveDiscoveryGroupBy`, `groupByFieldId`). The column keys differ per grouping: statuses versus select-option ids plus a `__none__` bucket. One flat `order` array would be wrong the moment `groupBy` changes. Storing a layout per `groupKey` also means switching groupBy back and forth does not lose the order.

### Opportunities board (`OPPORTUNITIES_BOARD`)
- filters: `squadIds` (0 or 1, matching the current single `?squad=`), `customField?: {fieldId, value}`
- display: `view` (`board|table`), `groupBy` (`status` or a field uuid), `sort` (`manual|score`), `columns`
- `columns.status.order` and `.hidden` are `OpportunityStatus` values. Unknown values are dropped on parse.

### Solutions board (`SOLUTIONS_BOARD`)
- Same shape as Opportunities. Column keys are `SolutionStatus`. The squad filter applies via the parent opportunity, as today.

### Roadmap (`ROADMAP_WORKSPACE`, `ROADMAP_ORG`)
- The existing schemas, unchanged.
- Add optional `display.columns` (key `horizon`, and `squad` and `workspace`) only in a late phase. It is not needed for the primary goal.

### Pure resolver `resolveColumns(layout | undefined, allKeys, defaultOrder, countsByKey)`
1. Order is: saved order filtered to known keys, then any known key not in the saved order appended in `defaultOrder`. This is decision 3. Unknown or stale keys are dropped silently.
2. With no layout, order is `defaultOrder`. For Opportunities this is a single exported constant, `ACTIVE, PRIORITIZED, VALIDATING, EXPLORING`, replacing the inline `COLUMNS` array. This is decision 2.
3. Visible means: not hidden, OR `countsByKey[key] > 0`. This is decision 4.
4. Visibility is computed at render time from live counts. It is never baked into the stored view, because counts change with filters and data.
5. The result also returns `forcedVisible: string[]`, the hidden-but-has-cards columns, for UI affordance.

This function is the single place the four decisions are enforced and is the main unit-test target.

## 4. Personal vs shared (recommendation)

**Recommendation: personal first for the new surfaces, schema and access already shared-ready.**

- `visibility`, `canShareOnSurface` and `canEditView` in `lib/roadmap-views/access.ts` already model PERSONAL/SHARED, and the Roadmap UI already exposes sharing. Do not regress that.
- For Opportunities and Solutions, ship with `SURFACES[...].sharing = false`. The Share toggle is hidden and the service rejects `SHARED` for those surfaces. Turning it on later is a one-line flag plus tests, with no migration.
- Why personal first: nobody can change a colleague's board by saving. There is no "who may edit a shared view" policy to settle first, and no conflict handling for a shared layout.
- The existing sharing rules carry over when enabled. Owner edits. A surface admin can delete a shared view. Others use Save as, which creates their own copy. Sharing never widens data access: config holds ids only, and queries re-scope to what the viewer can read.

| Option | Pros | Cons |
|---|---|---|
| Personal only | Smallest surface, no policy questions | Teams cannot agree on a shared board order |
| Personal first, shared-ready (recommended) | Ships fast, no migration to add sharing | Two code paths to test eventually |
| Shared first | Fits the "team convention" reading of column order | Needs an edit-rights policy, a workspace-default concept, and conflict handling before any value ships |

**Revisit if** early use shows people duplicating the same order by hand, or asking for "make this the workspace default". The follow-up is a `SHARED` toggle plus an optional workspace default flag. An `is_default` marker (per-user default view) is out of scope for now.

## 5. API / server actions

The existing actions in `app/[orgSlug]/roadmap/actions.ts` take `(orgSlug, workspaceId|null, input)`. Generalize them to a single set, with `surface` as a required argument validated against the registry:

- `createSavedViewAction(orgSlug, surface, workspaceId, input)`
- `updateSavedViewAction(orgSlug, surface, workspaceId, viewId, input, expectedUpdatedAt)`
- `deleteSavedViewAction(orgSlug, surface, workspaceId, viewId)`

**Behavior**
- Each action resolves the actor with `resolveRoadmapViewActor` (renamed `resolveSavedViewActor`) and enforces `access.ts` rules. Input is validated with the surface's zod schema. The result keeps the existing `{ok:true, view}|{ok:false, error}` union.
- `updateSavedViewAction` takes `expectedUpdatedAt` and fails with a "view changed elsewhere" error on mismatch. This is new. Two tabs saving the same view would otherwise silently overwrite each other. The current roadmap actions lack it, so add it for all surfaces together.
- Save as is just `create`, with the live state.
- Reads (`listSavedViews(actor, surface, workspaceId)`, `getSavedView`) are called from the server pages. There is no client fetch.
- After a write, `revalidatePath` for the surface page. Where the page already reads views per request, no cache invalidation is needed.
- Migration shim: keep `lib/roadmap-views/*` and the old action names as thin re-exports for one release, so the Roadmap cut-over PR stays small.

Suggested layout: `lib/saved-views/{surfaces,schema,columns,url,access,service}.ts` and a shared `app/[orgSlug]/saved-views-actions.ts`.

## 6. UI

Extract `SavedViewsMenu` from `components/roadmap/cross-workspace/saved-views-menu.tsx` into `components/saved-views/`. It is already surface-agnostic apart from the roadmap types and action imports.

- **Picker:** a "Views" dropdown in the page toolbar (`WorkspacePage` actions area) on all three surfaces. The first entry is "Default" (the built-in state). Then Mine, then Shared when enabled.
- **Modified state:** the trigger shows the view name plus a "Modified" dot when the live normalized state differs from the saved one (see `savedStateKey` below). Compare after normalization, so a saved order that is auto-extended with missing statuses is not "modified" on first load.
- **Actions in the modified state:**
  - Save (update the selected view, owner only)
  - Save as new view (name dialog)
  - Reset (navigate to `?saved=<id>`, discarding edits)
- **With no view selected and a non-default state:** the menu offers "Save as view" only.
- **Rename and Delete:** as today.
- **Columns control:** a "Columns" popover on boards with checkboxes (show/hide) and the current order, for keyboard users and the stacked mobile layout where drag is awkward. A badge "N hidden" shows when columns are hidden.
- **Forced-visible columns:** a hidden column that has cards renders with a small "hidden in view, has cards" marker. Its "Hide" menu item is disabled with a tooltip.
- Read-only members can use views and reorder columns locally. Reordering is view state, not data. They cannot save or share.

## 7. URL vs view precedence

Keep the existing contract (`saved`, `edited=1`, explicit params win), and extend it to the new surfaces.

Highest to lowest:
1. **Explicit URL params** (`view`, `groupBy`, `sort`, `squad`, `field`, `fieldValue`, `order`, `hide`).
2. **Selected saved view** (`?saved=<id>`), only when the URL is not `edited=1`.
3. **Built-in defaults**, including the Active-first order.

Rules:
- `edited=1` means the URL holds the full state, so a cleared filter stays cleared and a saved value cannot leak back in. The pages already do the equivalent for roadmap (`resolveWorkspaceRoadmapState`).
- A stale or foreign `saved` id (deleted, another surface, not visible) is ignored and falls through to defaults. No error page.
- **Column layout in the URL:** new compact params `order=ACTIVE,PRIORITIZED,...` and `hide=EXPLORING`, scoped to the current grouping. They are omitted when equal to the default. Without them, live column drags would be lost on refresh and could not be shared as a link. The params are validated with the same `resolveColumns` normalizer, with invalid tokens dropped individually, as `parseRoadmapParams` does.
- **Param name overlap:** the Roadmap uses `view` for board/timeline and discovery uses it for board/table. Each surface's registry owns its param map. Only `saved` and `edited` are global.
- `groupBy` changes do not carry `order` and `hide` across groupings. The URL columns apply to the active grouping only, and the saved layout is looked up by `groupKey`.
- Normalization happens in one pure `resolveSurfaceState(surface, searchParams, savedView)` shared by the server page and the client menu. This replaces the three page-local copies of the same logic.

## 8. Drag-to-reorder columns

- Use the existing `DndContext` in `opportunity-board.tsx`. Wrap the column row in a `SortableContext` with `horizontalListSortingStrategy`. This is the hardest part: the board already handles card drags and column drop zones (`column-${status}`).
- **Disambiguation:** give sortable columns their own id namespace (`colsort-<key>`) and `data: {type: "column"}`. `handleDragStart/Over/End` branch on `active.data.current.type`. Card logic is untouched when the type is `column`, and vice versa.
- **Drag handle:** only a grip in the column header starts a column drag. The column body keeps card drag, so the two cannot be confused.
- **Collision:** with `closestCenter` alone, a dragged card can resolve to a column sortable. Restrict by type in a small custom collision filter.
- **On drop:** compute the new order with `arrayMove`, write `order` (and `hide`) to the URL (replace, not push), and mark the view modified. Nothing hits the database until Save.
- **Keyboard and screen readers:** the existing `KeyboardSensor` plus the Columns popover give a non-drag path. Announce reorders via dnd-kit accessibility announcements.
- **Hidden columns** are not rendered and are not drop targets. A card cannot be dropped into a hidden column.
- **Group-by field boards** (`opportunity-field-board.tsx`, `solution-backlog-board.tsx`) get the same wrapper in a later step. They currently derive columns from field options.
- Mobile: under the `md` breakpoint columns are stacked or swiped. Use the Columns popover only; column drag is disabled there.

## 9. Test plan

**Unit (pure, highest value)**
- `resolveColumns`: default order; saved complete order; saved order missing statuses (appended in default order); unknown keys dropped; duplicates deduped; hidden column with 0 cards hidden; hidden column with cards forced visible; all columns hidden with zero cards leaves one visible or an empty-board state (decide; recommend show an empty-state prompt); a `__none__` bucket.
- Per-surface zod schemas: defaults, max-length caps, stale enum values, unknown `columns` keys, never-throw parse.
- `resolveSurfaceState`: precedence matrix (URL vs view vs default, `edited=1`, stale `saved`, foreign-surface id); URL round-trip (`stateToParams` then `parse` is identity); `savedStateKey` ignores order-insensitive list differences but is order-sensitive for `columns.order`.
- `access.ts`: existing tests plus `sharing=false` surfaces reject `SHARED`; surface and workspaceId consistency (`ROADMAP_ORG` needs null, others need non-null).

**Service / action (mock Prisma, as in `__tests__/roadmap-views-service.test.ts`)**
- CRUD per surface, cap of 50, duplicate-name check, cross-org and cross-surface isolation, `expectedUpdatedAt` conflict, legacy `surface = NULL` rows read as the derived surface.

**Migration**
- Update `__tests__/roadmap-views-migration.test.ts` and `__tests__/prisma-migrations.test.ts`: column is additive and nullable, async index, backfill idempotent, postcondition fails closed on NULL left behind.
- Rolling deploy: old-code row (NULL surface) is readable by new code.

**Component (Vitest, like `roadmap-header.test.tsx`)**
- Picker lists views per surface; modified indicator; save, save as, reset; Share toggle hidden on non-sharing surfaces.
- Board: renders Active-first with no view; renders saved order; appended statuses; forced-visible marker; hide disabled for non-empty columns.

**E2E (extend `e2e/functional/specs/roadmap-saved-views.spec.ts` style)**
- Opportunities: drag column, URL updates, reload preserves, Save as, reload via `?saved=` shows the same order. Another user does not see a personal view.
- Roadmap regression: existing saved views still load and apply after the migration.

Gate: push the branch, then run unit gates through `tq submit ... --wait` (see global instructions).

## 10. Phased implementation

Each step is one reviewable PR.

| # | PR | Behavior change | Depends on |
|---|---|---|---|
| 1 | `lib/saved-views/columns.ts`: `resolveColumns` plus exported `DEFAULT_OPPORTUNITY_COLUMN_ORDER`, with tests. Opportunities board consumes the constant. | None (default order unchanged) | - |
| 2 | Migration 098 (`surface` column, async index, backfill, postcondition, runner entry) and Prisma model rename to `SavedView` | None (NULL-tolerant, nothing reads `surface` yet) | - |
| 3 | `lib/saved-views/{surfaces,schema,access,service}` generalized, with `lib/roadmap-views/*` as re-export shims. Roadmap pages and actions switch over; roadmap behavior identical. Adds `expectedUpdatedAt`. | Roadmap internal only | 2 |
| 4 | Extract `SavedViewsMenu` to `components/saved-views/` and make it surface-generic; Roadmap uses it | None visible | 3 |
| 5 | Opportunities URL state: `resolveSurfaceState`, `order`/`hide` params, board reads layout from URL via `resolveColumns`, Columns popover | Column hide/reorder via URL | 1, 3 |
| 6 | Opportunities saved views: schema, picker on the discovery page, save / save as / reset / modified state, personal only | Feature visible | 4, 5 |
| 7 | Column drag-to-reorder on the Opportunities board (sortable wrapper, handle, collision filter, a11y) | Drag works | 5 |
| 8 | Solutions backlog: same as 5 to 7 (status board, then field-grouped boards) | Solutions parity | 6, 7 |
| 9 | Field-grouped Opportunities board column layouts (`groupKey` per field) | Parity for field grouping | 7 |
| 10 | Roadmap horizon column layout (optional) | Roadmap parity | 3, 7 |
| 11 | Enable sharing on Opportunities and Solutions (flag, tests, UI copy); decide workspace default | Sharing | 6, usage signal |
| 12 | Contract: remove `surface` NULL fallback and legacy shims | Cleanup | 3 shipped one release |

Steps 5 and 7 can be released together to Opportunities first if a smaller slice is wanted: 1, 5, 7 give column order and hide through the URL with no persistence, then 2, 3, 4, 6 add saving.

## 11. Consequences

**Easier:** one picker, one service, one set of access rules for every board. Adding a surface is a registry entry plus a schema. Column order is shareable as a link even without a saved view. Roadmap gains optimistic-concurrency protection.

**Harder:** two layers of state (URL and saved view) now exist on three surfaces, so precedence bugs are the main risk. `roadmap_views` is a misleading table name for good. The board's drag code grows a second drag type.

**Giving up:** a clean table and constraints (option B). Per-user "last used layout" persistence. Workspace-default views and sharing on the new surfaces at launch.

## 12. Risks and open questions

- **DSQL DDL:** confirm `ADD COLUMN` (nullable, no default) is accepted on DSQL in the target environment before merging PR 2. If not, fall back to option B.
- **Column drag versus card drag** conflicts in a single `DndContext` are the likeliest implementation defect. Prototype in PR 7 before building on it.
- **Personal-first may be the wrong bet** if column order is a team convention (see riskiest assumption).
- **All columns hidden:** unspecified. Recommend showing an empty state with a "Show columns" button.
- **URL length:** field-grouped boards put option uuids in `order`/`hide`. The cap of 50 keys per list bounds this, but long links are possible.
- **Assumption designed against:** no product input was available on sharing timeline or workspace defaults, so those stay deferred.

What would make me revise this: DSQL rejecting the additive column (move to option B), or usage showing teams need one shared board order (pull step 11 forward).
