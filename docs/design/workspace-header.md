# Workspace header pattern

> **Status: implemented** on Tasks, Discovery, Experiments, Decisions, Feedback
> and Roadmap. One item is reserved but not wired: the saved-views icon button
> (see *Saved views*). Companion to [`ui-system.md`](./ui-system.md) (tokens,
> layers, primitives).

## Scope

The header of a **workspace-level list/board page**: Tasks, Discovery,
Experiments, Decisions, Feedback, Roadmap. All six render the shared frame in
`components/patterns/workspace-page.tsx`. Roadmap renders `WorkspaceHeader`
directly from `RoadmapHeader` because its timeline state lives in a client
component; the other five use `WorkspacePage`.

Out of scope: document-style pages that use `PageHeader`
(`components/patterns/page-header.tsx`) — Settings, Capture, OKRs, Canvas, Agent,
detail pages. `PageHeader` is a title block with actions; it has no toolbar,
no view switching, and no sticky/collapse behavior to standardize.

## Anatomy

```
┌─ workspace-header ───────────────────────────────────────────────┐
│ Title                        [controls…]   [actions: View … ⋯]   │
│ description (≥ sm, optional)                                     │
├─ workspace-toolbar (optional) ───────────────────────────────────┤
│ page-specific secondary controls                                 │
├─ workspace-content ──────────────────────────────────────────────┤
```

- `title` — one `h1`, truncates, never wraps. It is the thing that must survive
  on a 390px phone.
- `description` — optional, hidden under `sm`. Use only when the page name is
  not self-explanatory (today only Decisions sets one).
- `actions` — the right-hand cluster, in the slot order below.
- `controls` — an optional secondary cluster rendered **after `actions`**, both
  in the DOM and visually: to the right of `actions` from `md` up, and on its
  **own full-width row below the title under `md`**. So put the View switcher in
  `actions` and everything that follows it in slot order in `controls` (Roadmap:
  view toggle in `actions`; timeline navigation, group-by, filter and ⋯ in
  `controls`). Use it for controls that would crowd the title on a phone.
- `toolbar` — an optional second row for persistent page-specific controls
  (Feedback's grid toolbar). A toolbar whose only content is an empty
  `[data-toolbar-host]` element paints no bar (`has-[[data-toolbar-host]:empty]:hidden`),
  so a portal target can live in the slot without leaving an empty strip.

## Slot order

Left to right inside `actions`, each slot optional, order fixed:

1. **View** — the `view` switcher (board / list / table / timeline). Always
   first: it changes what the rest of the header means.
2. **Arrange** — group-by and sort. Only appears when the current view
   supports it; hidden, not disabled, otherwise.
3. **Filter** — one filter entry point per page: the shared
   `FacetedFilterMenu` (`components/patterns/faceted-filter-menu.tsx`).
4. **Primary action** — at most one visible create/add button
   (`WorkspaceCreateButton`). Last of the visible controls.
5. **More (⋯)** — a `WorkspaceMoreMenu` overflow for low-frequency,
   page-level actions. Rightmost.

Rule of thumb: **left of the primary action changes what you see; the primary
action and ⋯ change what exists or how the page is configured.**

## Shared components

All exported from `components/patterns/index.ts`.

| Component | File | Role |
|---|---|---|
| `WorkspacePage` | `workspace-page.tsx` | Full-height page: header, optional toolbar, content |
| `WorkspaceHeader` | `workspace-page.tsx` | The header frame alone, for pages whose header must live in a client component |
| `WorkspaceViewSwitcher` | `workspace-header-controls.tsx` | The View slot: an icon-only segmented switcher (`Tabs`), one icon per view with a tooltip; each option keeps its `label` as the accessible name and tab name |
| `WorkspaceIconButton` | `workspace-header-controls.tsx` | Icon-only outline button with tooltip, 44px touch target below `md`, 32px from `md`, and a disabled-reason wrapper |
| `WorkspaceMoreMenu` | `workspace-header-controls.tsx` | The ⋯ overflow trigger and menu shell; the page supplies the menu content |
| `WorkspaceCreateButton` | `workspace-header-controls.tsx` | The primary action: `Button size="sm"` with a `Plus` icon; label collapses to the icon below `sm` and stays as `aria-label` |

`WorkspaceMoreMenu` details:

- Trigger: icon-only outline button, default `aria-label="More actions"`,
  `MoreHorizontal` icon, wrapped in a tooltip.
- Content: `DropdownMenu` from `components/ui`, `align="end"`. Items may be plain
  actions, radio groups or checkbox items.
- `active` shows a dot on the trigger when something inside is non-default.
- Renders nothing when it has no children, so a page without overflow actions
  shows no empty ⋯.
- Do not put domain data fetching in it (see *Layer ownership* in `ui-system.md`).

## Rules

- **One `h1`, no wrapping.** Controls must never push the title below a usable
  width. If the cluster will not fit on a phone, controls collapse to icon-only
  (label `hidden sm:inline`, keep `aria-label`) or move to `controls` before any
  are dropped.
- **Primary action is a single `WorkspaceCreateButton`.** If a page has two
  create actions, one belongs in ⋯ or in the content area.
- **The primary action opens a dialog**, keeping the user on the page. The one
  exception is Decisions, whose creation is a full-page flow: it is a link to
  `/decisions/new` styled with `buttonVariants({ size: "sm" })`.
- **Hidden, not disabled,** for controls that do not apply to the current view.
- **One control size.** Every button and the view switcher in the header is 44px tall below `md` (touch) and 32px from `md`. `WorkspaceHeader` enforces this with descendant selectors, so a control that is also used outside the header (`FacetedFilterMenu`, `Tabs`) keeps its own size there. Do not size header controls per page.
- **Filter is an icon too.** Pass `iconOnly` to `FacetedFilterMenu` in the header: a `ListFilter` icon button with a tooltip, accessible name "Filters", and the active-group count as a corner badge. Outside the header (data-grid toolbar) it keeps its label.
- **The View slot is icons, not text.** Use `WorkspaceViewSwitcher` with `Columns3` (board), `List`, `ChartGantt` (timeline) or `Table`; never a text `Tabs` list.
- **Tooltips on every icon-only control**, and the accessible name is the
  tooltip text.
- **Semantic tokens only** (`border-border-default`, `bg-surface-app`, …);
  `pnpm ui:colors` must not regress.
- **Workspace branding:** controls inherit `--primary` / `--ring`; do not hard-code.
- **Suspense:** wrap URL-state-reading controls (`useUrlState`) in `Suspense`
  so the header shell paints without them.

## Narrow-width behavior

Below `md` the header wraps. The title has an 8rem minimum width, so an
`actions` cluster too wide to sit beside it (View + Filter + Primary + ⋯)
drops to its own right-aligned row rather than squeezing the title to "T…".
A short cluster (Experiments: primary only) stays on the title row. `controls`
always wrap to their own row under `md`. Every page must be checked at 390px.

## Per-page mapping

| Page | View | Arrange | Filter | Primary | ⋯ |
|---|---|---|---|---|---|
| Tasks | list / board | — | `TasksFilters` | New task (dialog) | — |
| Discovery | board / table | group-by (board), sort (board + status + scoring model) | `DiscoveryFilters` | New Opportunity (dialog) | — |
| Experiments | — | — | filters | New Experiment (dialog) | — |
| Decisions | — (tabs are content-level) | — | Search / Date / Filters cluster (see below) | New decision (link) | — |
| Feedback | — | — | grid toolbar in the `toolbar` slot | New Feedback (dialog) | — |
| Roadmap | board / timeline | group-by (timeline), in `controls` | squad + tag filters, in `controls` | — | Timeline scale, Reload timeline (timeline only) |

Notes:

- **Decisions** keeps its Search / Date / Filters cluster: search and a date
  range are not faceted-filter groups, so it does not use `FacetedFilterMenu`.
  Its primary action is the only link-style one.
- **Roadmap** used to fold squad and tag filters into a "View options" menu.
  Those are now a regular `FacetedFilterMenu`; the remaining low-frequency
  items (timeline scale, reload) are the ⋯ menu.
- **Feedback** filters depend on client grid state, so they cannot be passed as
  server props. The page renders an empty `[data-toolbar-host]` element
  (id `FEEDBACK_TOOLBAR_HOST_ID`, `components/feedback/feedback-toolbar-host.ts`)
  in the `toolbar` slot and `DataGrid` portals its toolbar into it. The host is
  server-rendered, so it is present on first paint, and an empty host hides the
  bar.
- **Tasks** board state is seeded once from server data, so the create dialog
  announces new tasks through `dispatchTaskCreated` (`lib/task-created-event.ts`,
  a `compass:task-created` window event) that `TaskBoard` listens for, and also
  calls `router.refresh()` for the list view and server truth. A task created
  while a filter excludes it stays visible on the board until the next remount
  or refresh.

## Saved views

Saved views belong in the **View slot as an icon button**, next to the view
switcher. The slot is reserved; nothing is wired. The saved-views menu
component only exists on unmerged branches (for example
`feat/cross-workspace-roadmap-views`), not on `main`. When it merges, mount it
as a `WorkspaceIconButton`-sized trigger directly after the view switcher and
do not add a second place for saved views.

## Where this is recorded

- `ui-system.md` links to this file from the pattern-guides line.
- `/ui` registry (`components/ui-registry.tsx`) shows a `WorkspacePage` example
  with the full cluster, a primary-only header, `WorkspaceMoreMenu`, and the
  narrow-width layout.
- Tests: `components/patterns/workspace-header-controls.test.tsx`,
  `components/roadmap/roadmap-header.test.tsx`.
- No new tokens are required.

## Verification checklist (per page)

- [ ] Slot order matches *Slot order* for every control present
- [ ] Title visible and un-wrapped at 390px
- [ ] Every icon-only control has a tooltip and `aria-label`
- [ ] 44px targets below `md`
- [ ] Controls not applicable to the current view are hidden
- [ ] `pnpm ui:colors` and `pnpm ui:primitives` pass
- [ ] `/ui` registry example updated
