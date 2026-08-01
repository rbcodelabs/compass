# Design: Shared entity detail panel

**Status:** In progress — PR 1 (foundation) landed; PRs 2–4 planned.
**Author:** Rick + Claude
**Context:** Canvas gained click-to-detail as the motivating case, but we want *one* detail panel reused across every workspace screen (Canvas, OKRs, Discovery, Experiments, Roadmap, Feedback).

## Goal

Click any entity card, anywhere, and see its details in a side panel — the same panel everywhere, URL-addressable, with inline editing.

## Key realization: the infrastructure already exists

`components/panels/` is a globally-mounted right-side Sheet system:

- `PanelProvider` + `usePanelContext().openPanel(type, id)` / `closePanel()`, mounted once in `app/[orgSlug]/[workspaceSlug]/layout.tsx`, so `openPanel(...)` is callable from every workspace screen.
- `PanelShell` renders a Base UI `Sheet` (right side) and switches on `panel.type`.
- Fed by `/api/panels/*` route handlers via a client `fetch` → JSON → render pattern.

It already had `opportunity` and `experiment` panels, but **only roadmap cards and the mobile header triggered it**, and **Canvas nodes had no click handler at all**. So this project is mostly *wiring + filling gaps*, not building foundations.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Panel UX | **Reuse the Sheet overlay now; a docked/resizable sidebar is a later follow-up** | The Sheet is built, consistent, and works on every screen today. On Canvas it overlays part of the graph while open — acceptable for v1; docked layout revisited if it feels cramped. |
| URL binding | **URL-addressable** (`?detail=<type>:<id>`) | Shareable links, browser-back closes, survives refresh — and directly delivers Canvas's already-planned "URL deep-linking" item. Plain `useSearchParams` (no `nuqs` in the repo). |
| Editing | **Inline editing** in the panel (members can edit) | Editing entity fields is core PM work; admin gates stay reserved for settings/destructive actions. |
| Scope | **Full sweep** — all 8 entity types, wired on every screen incl. Canvas | The infra already exists, so the marginal cost of covering everything is low. |

## Architecture

1. **Shared fetch layer — `lib/entity-detail.ts`** *(built, PR 1)*
   `getEntityDetail(type, id, workspaceId)` → discriminated union `{ type, data }` or `null`. One `type → Prisma query` dispatch replacing the previous scatter (some queries were inline in the MCP route returning markdown, some in ad-hoc panel routes, some missing).
   - **Access control (fixes a real IDOR):** every query is workspace-scoped. Directly-scoped entities (Opportunity, Experiment, RoadmapItem, Feedback) filter on their own `workspaceId`; indirectly-scoped ones via Prisma relation filters through the parent chain — Solution→Opportunity, Assumption→Solution→Opportunity, KeyResult→Objective→OKRCycle, Objective→OKRCycle. A miss returns `null` → 404, never leaking cross-workspace existence.

2. **Consolidated API — `app/api/panels/entity/[type]/[id]/route.ts`** *(built, PR 1)*
   `GET …?orgSlug&workspaceSlug`. Two-layer auth: session **and** workspace membership (`getWorkspace` only returns a workspace the caller belongs to), then `getEntityDetail` scopes the query. The old per-type routes (`/api/panels/opportunity/[id]`, `/api/panels/experiment/[id]`) — which were session-only with **no** scoping — are removed and their clients migrated here.

3. **URL-addressable panel state** *(PR 2)*
   Extend `PanelProvider` so the open entity lives in a search param as the source of truth (`openPanel` writes it, close removes it, back closes, refresh restores). `PanelType` widens to all 8 types.

4. **Eight panel bodies + shared sub-components** *(PR 2)*
   Mirror the existing opportunity/experiment panels for the 6 missing types. Extract shared `PanelHeader / StatusBadge / RelationList / FieldRow` to keep 8 panels consistent (guard against drift). Relation lists are clickable → `openPanel` to hop between related entities, each hop updating the URL.

5. **Triggers on every screen** *(PR 2)*
   - **Canvas:** `onNodeClick → openPanel(node.type, node.id)` (node ids *are* entity ids).
   - OKRs (`objective-row`, `key-result-bar`), Discovery (`opportunity-card`, `solution-card`), Experiments (`experiment-card`), Feedback (rows): card body opens the panel; keep an "Open full page" affordance inside the panel.
   - Roadmap already triggers panels for linked chips; also open a `roadmapItem` panel from the card itself.

6. **Inline editing** *(PR 3)*
   Reuse per-entity mutation server actions + the inline-edit patterns already in `objective-row`/`key-result-bar`/`solution-card`. Optimistic update + `refresh()`. Writes gated by workspace membership.

## PR breakdown

- **PR 1 — Foundation + IDOR fix** ✅: `lib/entity-detail.ts`, consolidated scoped route, migrate + delete old routes, unit tests (scoping per type + cross-workspace-access regression). No UI change beyond the two panels' fetch URL.
- **PR 2 — Read-only panels + URL sync + wiring**: the 6 panel bodies, shared sub-components, URL-addressable state, triggers on every screen **including Canvas**. This is where "click a card anywhere → details" lands end-to-end.
- **PR 3 — Inline editing**: per-entity editable fields + permissions + optimistic updates.
- **PR 4 — Polish**: e2e per screen, user-facing docs page, a11y/mobile pass.

## Risks / open items

- **Consistency across 8 panels** is the main quality risk — shared sub-components are the mitigation.
- **Docked-sidebar** variant deferred; the Sheet overlays the Canvas graph while open.
- Switching Opportunity/Experiment/Solution cards from full-page navigation to the panel changes established UX; mitigated by keeping "Open full page" in the panel.
- Edit-permission model (PR 3): members-can-edit chosen; revisit if finer-grained roles are needed.
