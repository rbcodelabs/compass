---
title: "MCP API"
description: "Integrate Compass into AI agents via the Model Context Protocol"
icon: "Zap"
order: 9
section: "Developer"
---

# MCP API

## PM interview processing

`get_pm_interview({ interviewId, offset? })` reads the initiating user's saved
interview and current target in an authorized workspace. It returns transcript
pages, permitted descriptive fields, and current `expectedUpdatedAt` and
`expectedFieldsFingerprint` values. Follow `nextOffset` until it is null. This
does not expose participant credentials, raw audio, or other users' interviews.

Finishing an interview starts the normal core agent with a temporary credential
restricted to that interview's exact target. Its edit must supply both returned
version checks. The server checks the exact fields again at the final write and
commits a before/after receipt atomically. A changed baseline requires rereading
and reconsidering the edit, not blindly replacing the version token.

`update_opportunity` supports `customerSegment` in addition to title/description.
`update_opportunity`, `update_solution`, and `update_assumption` accept optional
`expectedUpdatedAt` for ordinary optimistic edits. The fingerprint parameter is
required only for an automatic interview update; it is never a target field.

`update_experiment({ experimentId, title?, hypothesis?, method?, killCondition?,
expectedUpdatedAt?, expectedFieldsFingerprint? })` edits protocol fields only
while the experiment is **DESIGNING**. It cannot change status or record results.
The automatic interview credential cannot edit risk, lifecycle, relationships,
other items, or customer evidence through any tool. After processing terminates,
an explicit new chat message uses the user's normal core-agent permissions.

Compass exposes a **Model Context Protocol (MCP)** endpoint that lets AI agents read and write discovery data programmatically. This means you can connect tools like Claude, Cursor, or any MCP-compatible client to your workspace and have AI assistants create OKRs, log opportunities from user research notes, or update experiment results — all without leaving your AI workflow.

## Endpoint

```
POST /api/mcp
```

The MCP endpoint uses **Streamable HTTP transport**, which is compatible with all modern MCP clients.

## Authentication

Generate an API key from **Settings → API Keys**. Pass it as a Bearer token in the `Authorization` header:

```http
Authorization: Bearer compass_your_api_key_here
```

Personal keys act with their owner's access and any credential restrictions. Registered-agent keys work across explicitly granted workspaces and are limited by the owner's current membership, grant level, and permitted tools. Treat API keys like passwords — revoke and replace a key if it is compromised.

Access is determined entirely by the key in the request. The client sending it — a desktop AI app, an editor, a script, or an unattended scheduled job — makes no difference, so give an automation the narrowest credential that still does the job. For a comparison of every credential type and guidance on choosing between them, see [Identity and Access](/help/21-identity-and-access).

## Required Request Headers

Every **POST** request must include these headers:

```http
Authorization: Bearer compass_your_api_key_here
Content-Type: application/json
Accept: application/json, text/event-stream
```

The Streamable HTTP transport can respond with either JSON or a server-sent event stream, so the `Accept` header must include **both** media types. A POST request missing either `application/json` or `text/event-stream` from `Accept` returns HTTP 406; a POST request without a JSON `Content-Type` returns HTTP 415. Standard MCP clients, including `mcp-remote`, set the transport headers automatically; add them yourself only when calling the endpoint directly.

For example, this raw request sends an MCP initialize request:

```bash
curl https://your-compass-url.vercel.app/api/mcp \
  --header "Authorization: Bearer compass_your_api_key_here" \
  --header "Content-Type: application/json" \
  --header "Accept: application/json, text/event-stream" \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl-example","version":"1.0.0"}}}'
```

## What Agents Can Do

The MCP server exposes tools that agents can call, grouped below by area.

### Shared comments

Comments are mutable discussion only. They do not approve work, authorize a release, or change a tracked Decision. `REVIEW_REQUEST` targets are accepted only for informational `TRACKED_DECISION` requests; immutable review revisions, options, Decision records/applications, legacy review gates, and release authorization are not commentable.

Phase 1 exposes the shared comment capability through the generic MCP tools and the existing Doc and Solution compatibility paths. It does not add a general Comments UI to every supported object. Until Phase 2, the existing Doc and Solution experiences remain the only comment UIs.

#### Production migration and backfill

After deploying application code containing migration `046_shared_comments`, run these commands from the Vercel-linked Compass main checkout (the directory containing `.vercel/project.json`). The authenticated admin routes use Vercel OIDC for Aurora DSQL, require `MIGRATION_SECRET`, and always select `getActiveSchema()` for that deployment. First apply the additive schema migration:

```bash
vercel curl /api/admin/migrate \
  --deployment "$DEPLOYMENT_URL" \
  -- --request POST \
     --header "Content-Type: application/json" \
     --header "x-migration-secret: $MIGRATION_SECRET" \
     --data '{"script":"046_shared_comments"}'
```

Then invoke one bounded backfill batch at a time. Repeat the same request until the JSON response reports `"complete": true`; a retry after a timeout or ambiguous response is safe because rows retain their legacy IDs and inserts use conflict-safe idempotency. The response contains aggregate processed and invariant counts only.

```bash
vercel curl /api/admin/shared-comments-backfill \
  --deployment "$DEPLOYMENT_URL" \
  -- --request POST \
     --header "Content-Type: application/json" \
     --header "x-migration-secret: $MIGRATION_SECRET" \
     --data '{"operation":"backfill","batchSize":500}'
```

Finish with a read-only validation request. It succeeds only when every legacy comment has a matching shared row, required extensions exist, reply topology is valid, and no legacy row is orphaned:

```bash
vercel curl /api/admin/shared-comments-backfill \
  --deployment "$DEPLOYMENT_URL" \
  -- --request POST \
     --header "Content-Type: application/json" \
     --header "x-migration-secret: $MIGRATION_SECRET" \
     --data '{"operation":"validate"}'
```

HTTP `409` means validation failed or the backfill cannot make safe progress. Resolve orphaned legacy data explicitly; the endpoint never fabricates workspace ownership. Rollback remains application-code-only: revert the runtime code and leave the additive shared tables in place so the unchanged legacy tables and current UIs continue to operate.

Supported `targetType` values are `OBJECTIVE`, `KEY_RESULT`, `OPPORTUNITY`, `SOLUTION`, `ASSUMPTION`, `EXPERIMENT`, `ROADMAP_ITEM`, `FEEDBACK_ITEM`, `TASK`, `DOC`, `ARTIFACT`, `RESEARCH_STUDY`, and `REVIEW_REQUEST`.

| Tool | Description |
|---|---|
| `add_comment` | Add a root comment or one-level reply. Requires `workspaceId`, `targetType`, `targetId`, `body`, and `authorName`; `parentId` is optional |
| `list_comments` | List comments for an exact workspace and target, optionally filtered by `OPEN` or `RESOLVED` |
| `get_comment` | Get one comment and any specialized Doc-anchor or Solution-plan metadata |
| `update_comment` | Edit a comment body |
| `delete_comment` | Delete a reply, or a root and its replies |
| `resolve_comment` | Mark a comment resolved |
| `reopen_comment` | Mark a resolved comment open |

### Workspace

| Tool | Description |
|---|---|
| `get_workspace_summary` | Returns high-level counts and status for a workspace: OKR cycles, opportunities, experiments, roadmap items, active experiments, active OKR cycle, and squads |
| `list_workspaces` | List all workspaces in an organization by org slug; use as the first call when you don't yet know a workspace ID |
| `get_workspace_by_slug` | Look up a single workspace's ID, name, and description directly by org slug + workspace slug, without listing all workspaces |
| `create_workspace` | Create a new workspace inside an organization |

### OKRs

| Tool | Description |
|---|---|
| `list_okr_cycles` | List all OKR cycles for a workspace with IDs, titles, dates, and status |
| `create_okr_cycle` | Create a new OKR cycle for a workspace (defaults to DRAFT status) |
| `get_okr_cycle` | Return a full OKR cycle with Objective/KR progress, higher-level parent links, and supporting Objectives |
| `create_objective` | Create an Objective; optionally assign a squad or link to an eligible KR in a longer-horizon cycle |
| `update_objective` | Partially update an Objective's title, description, or status (ON_TRACK/AT_RISK/OFF_TRACK/COMPLETE) |
| `delete_objective` | Permanently delete a childless Objective and its Task links/entity metadata; refuses deletion while child Key Results exist |
| `add_key_result` | Add a Key Result to an existing Objective |
| `update_key_result` | Partially update a Key Result's title, target, unit, or current value |
| `delete_key_result` | Permanently delete a Key Result; atomically unlinks Opportunities, supporting Objectives, Roadmap Items, and Tasks, then deletes dependent Check-Ins/entity metadata |
| `log_checkin` | Record a progress check-in for a Key Result and update its current value |
| `list_eligible_parent_key_results` | List open, longer-horizon KRs whose cycle contains the specified child cycle |
| `set_objective_parent_kr` | Link an Objective to an eligible higher-level KR it supports, or clear the link |

### Discovery — Opportunities, Solutions, Assumptions

| Tool | Description |
|---|---|
| `list_opportunities` | Fetch all opportunities in the workspace, including each opportunity's description, status, squad, solution count, and linked Key Result; filterable by `updatedSince`/`updatedBefore` and orderable with `sort` (`recentlyUpdated` / `leastRecentlyUpdated`) |
| `get_opportunity` | Return full detail for an opportunity: solutions, assumptions per solution, and experiments linked to those assumptions |
| `list_solutions` | Discover solutions across a workspace by solution status, parent opportunity status/squad, and roadmap-link presence; returns stable Opportunity and Roadmap Item IDs without making a readiness judgment; filterable by `updatedSince`/`updatedBefore` and orderable with `sort` (`recentlyUpdated` / `leastRecentlyUpdated`) |
| `list_assumptions` | Discover assumptions across a workspace by status, risk, parent Solution status, and parent Opportunity status/squad; returns stable ancestry IDs and experiment counts; filterable by `updatedSince`/`updatedBefore` and orderable with `sort` (`recentlyUpdated` / `leastRecentlyUpdated`) |
| `create_opportunity` | Create a new opportunity with title, description, status |
| `update_opportunity` | Update an existing opportunity's title and/or description; pass `null` to clear its description |
| `update_opportunity_status` | Move an opportunity through its discovery pipeline: EXPLORING → VALIDATING → PRIORITIZED → ACTIVE → ARCHIVED |
| `link_opportunity_to_kr` | Associate an opportunity with a Key Result it is expected to move (or clear the link) |
| `add_solution` | Add a proposed Solution to an Opportunity |
| `update_solution_status` | Update a Solution's lifecycle status (IDEA/VALIDATED/IN_DELIVERY/SHIPPED/KILLED); any valid status may transition directly to any other valid status |
| `update_solution` | Update an existing Solution's title and/or description (pass an empty string to clear the description); at least one field must be provided |
| `add_assumption` | Add a testable Assumption to a Solution, with a risk level (HIGH/MEDIUM/LOW); starts UNTESTED |
| `update_assumption` | Update an Assumption's title, description, risk level, or status (UNTESTED/TESTING/VALIDATED/INVALIDATED) |
| `delete_assumption` | Permanently delete an Assumption; unlinks (does not delete) any Experiments or Evidence that referenced it |
| `add_solution_plan` | Log a proposed implementation/engineering plan on a Solution as the pinned "current plan" entry in its Plan & Discussion thread; a later call on the same solution supersedes the previous plan |
| `add_solution_comment` | Add a reply comment to a Solution's Plan & Discussion thread |
| `list_solution_comments` | Fetch the full Plan & Discussion thread for a Solution in chronological order, each entry labeled PLAN or COMMENT |
| `get_solution_comment` | Fetch a single Plan & Discussion entry by ID |
| `update_solution_comment` | Edit the body of an existing Plan & Discussion entry |
| `delete_solution_comment` | Permanently delete a Plan & Discussion entry |
| `approve_solution_plan` | Mark a PLAN entry as APPROVED (only applies to PLAN entries, not COMMENT replies) |
| `reject_solution_plan` | Mark a PLAN entry as REJECTED (only applies to PLAN entries, not COMMENT replies) |
| `promote_to_roadmap` | Promote a validated Solution directly to the roadmap, creating a Roadmap Item linked back to the originating opportunity. Accepts an optional `isPrivate` flag |

`approve_solution_plan` and `reject_solution_plan` preserve the legacy, reversible plan-status marker only. They do not create a tracked Decision, authorize delivery, or establish authoritative approval semantics for new plans.

### Experiments

| Tool | Description |
|---|---|
| `list_experiments` | Fetch experiments with optional status, squad, logged-result-presence, `updatedSince`, and recorded `endBefore` filters; summaries include dates, timestamps, result count/latest-result time, and stable Assumption/Solution/Opportunity IDs |
| `get_experiment` | Return full details for a single experiment: hypothesis, method, kill condition, linked assumption, all logged results, and conclusion |
| `create_experiment` | Create a new experiment with hypothesis and method (starts in DESIGNING status) |
| `log_experiment_result` | Record an observation or data point for a running experiment |
| `conclude_experiment` | Conclude an experiment with PROCEED, KILL, ITERATE, or NOT_PURSUED (deliberately never run — e.g. the feature already shipped); automatically updates the linked Assumption's status (PROCEED → VALIDATED, KILL → INVALIDATED, ITERATE → UNTESTED, NOT_PURSUED → UNTESTED). NOT_PURSUED requires a `reason` and lands on its own terminal status distinct from KILLED, so a deliberate non-pursuit is never mistaken for an evidence-based kill |

### Roadmap

| Tool | Description |
|---|---|
| `list_roadmap_items` | Fetch active roadmap items for a workspace in rank order, grouped by horizon (including LAUNCHING/LAUNCHED), with dates, timestamps, `sortOrder`, commitment provenance, and stable linked-object IDs; filterable by `updatedSince`/`updatedBefore` and orderable with `sort` (`recentlyUpdated` / `leastRecentlyUpdated`) |
| `add_to_roadmap` | Create a roadmap item in NOW, NEXT, LATER, or SHIPPED, optionally with dates and an `isPrivate` flag |
| `update_roadmap_item` | Update a roadmap item's ordinary horizon, status, title, description, dates, or `isPrivate` flag. NOW behaves like other ordinary horizons; LAUNCHING/LAUNCHED use the launch workflow |
| `request_decision` | Request a tracking-only human decision linked to a workspace, Opportunity, Solution, Roadmap Item, Doc, Experiment, or Feedback item, with up to 12 supporting Compass sources |
| `list_decisions` | List tracking-only decisions newest-first, optionally filtered by state (`PENDING`, `DECIDED`, or `AWAITING_FOLLOW_THROUGH`), linked item type, outcome, reviewer, or search text |
| `get_decision` | Read one tracking-only decision, its immutable revision history, the resolved requester (the human or Agent who raised it), and any linked follow-up Tasks |
| `close_decision_no_action` | Explicitly close a DECIDED decision as needing no follow-up work, with a required reason. Refuses if the decision already has a linked follow-up Task or was already closed this way |
| `request_release_authorization` | Prepare an immutable production-release review for one exact GitHub repository, PR number, base ref, 40-character head SHA, release-policy ID, and non-empty set of same-workspace Task IDs. This operation never takes the human decision or invokes release automation |
| `list_release_runs` | List recorded release-authorization runs by ledger state, covered Task, or `updatedSince`, including exact repository/PR/head SHA, Task IDs, authorization Decision ID, dispatch state, and a stable GitHub PR URL |
| `get_review_request` | Read a review request, its current immutable revision, options, and recorded decision |
| `list_review_requests` | List review requests for a workspace, optionally filtered by state |
| `apply_recorded_decision` | Idempotently apply the authorized continuation from a recorded decision and return its application receipt |
| `create_checklist_template` | Create a reusable launch checklist template for a workspace, scoped to a launch tier (TIER_1/TIER_2/TIER_3), with an ordered list of items |
| `list_checklist_templates` | List a workspace's checklist templates, optionally filtered by launch tier |
| `set_launch_tier` | Move a roadmap item into the LAUNCHING horizon by picking a launch tier; attaches a checklist cloned from an explicit or auto-resolved (most recent ACTIVE) template for that tier. Rejects items already LAUNCHING/LAUNCHED |
| `get_launch_checklist` | Get the launch checklist for a roadmap item, including each item's status and ID |
| `update_launch_checklist_item` | Set a launch checklist item's status (PENDING/DONE/SKIPPED) |

Decision-taking is deliberately absent from MCP. A signed-in human reviewer opens
the stable Compass review URL and chooses one option. Agents may prepare and read
packets, then apply a recorded decision; they cannot impersonate the reviewer.

`AWAITING_FOLLOW_THROUGH` is a computed `list_decisions` state, not a stored
column: a DECIDED decision with no `DECISION`-type Task link pointing at it and
not explicitly closed via `close_decision_no_action`. Linking a follow-up Task
(`link_task` with `linkedType: "DECISION"`) or calling
`close_decision_no_action` both remove it from this list — the pairing makes
"we decided but never acted on it" a queryable, honest state instead of a
silent gap. `request_decision` also records which Agent (if any) raised the
request, distinct from the API key's owning user, so `get_decision`'s resolved
requester can point at the Agent that was blocked waiting on the answer.

`request_decision.sources` is an optional array of `{ type, id }` references.
Supported types are `WORKSPACE`, `OPPORTUNITY`, `SOLUTION`, `ASSUMPTION`,
`ROADMAP_ITEM`, `DOC`, `EXPERIMENT`, `FEEDBACK`, and `EVIDENCE`. Compass removes
duplicates and the primary linked item, validates every reference within the
declared workspace, and snapshots the source title and `updatedAt` version into
the immutable packet. If any source is missing or belongs to another workspace,
the whole request fails and no review is created. Put readable reasoning in the
Markdown `context`; do not embed source UUIDs there.

`apply_recorded_decision` applies a decided review request through the
applicator matching its `gateType`, and is idempotent: a repeat call replays
the existing receipt rather than reapplying or creating a second one. A
registered agent may call it (it is classified as an agent WRITE, not
human-only) but can never take the underlying decision — only a signed-in
human admin chooses an option, via the review URL above.

- **`TRACKED_DECISION`** (the default queue created by `request_decision`):
  every outcome resolves to `NO_ACTION`. Applying only records a durable
  receipt confirming the decision was carried out; it never mutates product
  state.
- **`RELEASE_AUTHORIZATION`**: validates the authoritative provider snapshot
  outside the database transaction, then a short transaction binds the
  unchanged snapshot and human decision to a durable dispatch row. Compass
  does not merge, deploy, or otherwise invoke external release automation in
  this implementation. Provider validation is unconfigured by default and
  therefore fails closed (`PR_NOT_READY`); a dispatch worker must use a
  configured provider and repeat the same head/check/policy revalidation at
  the dispatch-claim boundary before any future external side effect.

`list_release_runs` reports Compass ledger facts only. A release-run state does
not prove that GitHub merged the PR, that a deployment reached production, or
that feature smoke tests passed. Completion workflows must re-read those facts
from the configured GitHub and deployment providers before changing lifecycle
state.

### Squads

| Tool | Description |
|---|---|
| `create_squad` | Create a squad in a workspace with a name and optional six-digit hex color |
| `list_squads` | List all squads in a workspace with their IDs and colors |
| `get_squad` | Return a squad's ID, workspace ID, name, and color |
| `update_squad` | Update a squad's name and/or color |
| `assign_squad` | Assign a Squad to any object — opportunity, experiment, roadmap item, objective, or task (or clear it) |

### Tasks

Task is the standalone delivery/tracking entity used both for full engineering sprint delivery (replacing a Jira-style board) and lightweight PM initiative tracking — one status vocabulary, `BACKLOG → TODO → IN_PROGRESS → BLOCKED ⇄ IN_REVIEW → DONE`, with `CANCELLED` as a terminal state and `BLOCKED` a first-class column. Tasks link to other Compass objects (Opportunity, Solution, Roadmap Item, Objective, Key Result, Doc, Experiment, Feedback Item, Decision) many-to-many via `TaskLink`, and support Epic → Task → Subtask hierarchy via `parentTaskId`. A `DECISION` link points at a tracking-only decision request (see `request_decision`/`list_decisions` above) and is how a decided-but-actionable decision gets its follow-up work tracked — see `AWAITING_FOLLOW_THROUGH` in the Roadmap section.

| Tool | Description |
|---|---|
| `create_task` | Create a Task with a title (required); optionally description, status (default TODO), priority (default MEDIUM), squad, parent task (to create a Subtask), assignee, freeform owner name, story points, due date, or iteration label |
| `get_task` | Return full detail for a Task: fields, parent Epic (if any), subtasks, and resolved links to other Compass objects |
| `list_tasks` | List tasks in a workspace, filterable by status, priority, squad, assignee, parent task (pass `null` for top-level Epics/tasks only), a linked object, `updatedSince`, or `updatedBefore`; orderable with `sort` (`recentlyUpdated` / `leastRecentlyUpdated`); summaries include created/updated timestamps and can optionally nest subtasks |
| `update_task` | Update a Task's title, description, priority, assignee, owner, story points, due date, or iteration — does not accept status |
| `move_task_status` | Dedicated status-transition tool for a Task, including moving it into or out of BLOCKED |
| `link_task` | Link a Task to another Compass object; idempotent — re-linking the same pair is a no-op |
| `unlink_task` | Remove a link between a Task and another Compass object |
| `list_task_links` | List all links for a Task, grouped by linked object type with resolved titles |

### Feedback

| Tool | Description |
|---|---|
| `create_feedback` | Create a new feedback item directly via MCP. Accepts 1–5 optional inline attachments with a combined decoded limit of 3 MiB; defaults to type IDEA |
| `list_feedback` | Fetch customer feedback items with vote counts, type, status, linked Opportunity ID, timestamps, and canonical Compass URLs. Pass `updatedSince` to start a stable incremental scan and the returned opaque `cursor` for each later page |
| `get_feedback_item` | Fetch full details for a single feedback item, including attachments, its linked opportunity, and its canonical Compass URL |
| `update_feedback` | Update a feedback item's title and/or description; pass `description: null` to clear it |
| `update_feedback_status` | Update a feedback item's status (OPEN, UNDER_REVIEW, PLANNED, IN_PROGRESS, COMPLETED, DECLINED), with an optional note. Legacy CLOSED remains temporarily accepted but is deprecated |
| `update_feedback_type` | Reclassify a feedback item as a BUG or an IDEA |
| `link_feedback_to_opportunity` | Link a feedback item (typically an IDEA) to an existing opportunity, connecting it to the discovery flow |
| `prepare_feedback_attachment_upload` | Prepare a signed, short-lived direct-to-Vercel-Blob upload for an attachment up to 10 MiB |
| `add_feedback_attachment` | Add one inline attachment to existing feedback, or complete a prepared direct upload using its Blob URL and signed receipt |
| `promote_feedback_to_roadmap` | Promote a feedback item (typically a BUG) directly to the roadmap, skipping discovery entirely. Accepts an optional `isPrivate` flag (e.g. for a security-flagged bug) |

Feedback create, read, list, update, status, type, link, and attachment responses include absolute canonical URLs that agents can give directly to users. Preview MCP responses point to the active Vercel branch/deployment URL, while production uses the configured Compass custom domain. Every feedback mutation also includes its affected entity ID on a plain `ID: <uuid>` line.

Without scan arguments, `list_feedback` keeps its legacy vote-count/recency
ordering and default limit of 50. That ranked batch is not proof the queue is
exhausted. For complete or incremental retrieval, pass an ISO `updatedSince`
timestamp (use the Unix epoch for a full historical scan), then follow
`nextCursor` until `hasMore` is false. The first page freezes an `asOf` upper
watermark, so records changed later appear in the next scan instead of shifting
between pages. A cursor is bound to its original workspace and normalized status
filter; pass a cursor by itself rather than combining it with `updatedSince`.

For screenshots and other small files, pass a base64 data URL (or raw base64 plus `fileType`) directly to `create_feedback` or `add_feedback_attachment`. Compass validates the encoded length before decoding and rejects the entire create request if any attachment cannot be uploaded; it never silently creates text-only feedback.

For files larger than the 3 MiB inline aggregate limit, use the two-step direct upload flow:

1. Call `prepare_feedback_attachment_upload` with the workspace, filename, MIME type, and exact file size (maximum 10 MiB).
2. Upload the file directly with `put(pathname, file, { access: "public", token: clientToken, contentType: fileType })` from `@vercel/blob/client`, using the returned pathname and client token.
3. Call `add_feedback_attachment` with the target feedback ID, returned Blob URL, and signed receipt.

The receipt expires after ten minutes and is scoped to the workspace, prepared attachment ID, pathname, MIME type, and byte size. Compass verifies the receipt, configured Blob store, and Blob metadata before creating the attachment row. The prepared ID makes concurrent completion idempotent; an ID already committed to another feedback item is rejected. Each feedback item accepts at most five attachments, enforced transactionally.

### Research studies

Research tools use the same validation, protocol-locking and link transactions as Capture. Per-user API keys require workspace membership; the existing trusted service key retains its service-account semantics. Participant research credentials cannot invoke any MCP tool. Research Capture must be enabled in the target environment; these tools do not enable it or voice.

| Tool | Description |
|---|---|
| `generate_research_guide` | Draft 5–8 editable questions or usability tasks from a goal, study type and duration; does not create a study |
| `create_research_study` | Create an active study with a reviewed guide and return its new participant link once |
| `list_research_studies` | Page through study settings and session counts in one workspace; no transcripts or participant identities |
| `get_research_study` | Read one study’s settings, guide and session count in its declared workspace |
| `update_research_study` | Update the name and supplied settings; omitted protocol fields are preserved, and protocol changes are locked after the first session |
| `activate_research_study` | Activate a draft or closed study and return a fresh participant link once |
| `close_research_study` | Close an active study and revoke PRIMARY participant links |
| `archive_research_study` | Archive a study and revoke PRIMARY links without deleting its research |
| `issue_research_link` | Issue a link only when the active study has no live PRIMARY link |
| `rotate_research_link` | Explicitly revoke prior PRIMARY links and return one new link for an active study |
| `revoke_research_links` | Revoke PRIMARY links without generating a replacement |

All tools require `workspaceId`; single-study operations also require `studyId`. Create requires `name`, `goal` and `guide`; update requires `name`, with optional protocol fields. Study types are `CUSTOMER_INTERVIEW` and `USABILITY_TEST`; supported durations are 10, 15, 20 and 30 minutes. Guided studies require a valid public HTTPS product URL. Guides allow 1–20 items, at most 1,000 characters each and 10,000 total; generated guides must be reviewed before creation.

List results use `{items, count, nextCursor}` with a default page size of 20 and maximum of 100, ordered newest first by creation time and ID. Pass `nextCursor` unchanged with the same workspace and status filter. Archived studies are excluded by default; request `status: "ARCHIVED"` to inspect them. Cursors do not authorize access and are rejected when malformed or reused with different scope. Concurrent edits may change metadata between pages; this is not a point-in-time export.

Successful mutation text includes `ID: <uuid>` on its own line and structured output contains the same ID. Newly issued links appear as `participantUrl` only in that operation’s response: store them securely. Only hashes are persisted. Neither get nor list can recover a link, expose its hash, return private attachment paths, or read participant transcripts. A lost response to a link mutation is ambiguous: inspect study state and use explicit rotation if a replacement is needed, rather than assuming the mutation failed.

Guide generation uses a tool-free runtime with a 45-second work deadline and bounded cleanup inside the existing MCP request budget. A timeout does not create a study. These tools do not expose research-session analysis or change model/voice rollout flags.

### Evidence

| Tool | Description |
|---|---|
| `add_evidence` | Attach a piece of evidence (interview, feedback, support ticket, experiment result, or analytics) to an opportunity, solution, or assumption |
| `link_evidence` | Re-parent existing evidence to a different opportunity, solution, or assumption |
| `list_evidence` | Fetch all evidence attached to a given opportunity, solution, or assumption |

### Docs

| Tool | Description |
|---|---|
| `list_docs` | List all docs in a workspace as an indented tree; use to discover doc IDs before calling `get_doc` or `update_doc`; filterable by `updatedSince`/`updatedBefore` and orderable with `sort` (`recentlyUpdated` / `leastRecentlyUpdated`). A doc whose parent is excluded by a recency filter is rendered at the top level so it stays reachable |
| `get_doc` | Return the full content of a single doc, including its parent, children list, complete markdown body, and `docType`/`roadmapItemId` when set |
| `create_doc` | Create a new doc in a workspace, optionally nested under a parent doc. Pass `roadmapItemId` and `docType: GTM_POSITIONING_BRIEF` to create a Positioning & Messaging Brief linked 1:1 to a roadmap item (auto-fills a starter template if content is omitted) |
| `update_doc` | Update an existing doc's title, content, and/or icon |
| `create_doc_version` | Save a manual, named snapshot of a doc's current content. Params: `docId`, `label` (optional), `authorName`. Always writes a new version, even if one was just saved seconds ago — named snapshots are never coalesced away |
| `list_doc_versions` | List a doc's saved versions (id, label, author, created date), newest first, alongside the doc's own current title and last-updated time as a reference point. Param: `docId`. Does not include full content — call `get_doc_version` for that |
| `get_doc_version` | Return the full title/content/metadata/icon snapshot of a single saved doc version. Param: `versionId` |
| `restore_doc_version` | Restore a doc's live content to a previously saved version. Param: `versionId`. The doc's current state is snapshotted first (labeled "Before restore"), so restoring never loses data |

Every `update_doc` call also automatically snapshots the doc's pre-change state before applying the new values (coalesced to one snapshot per 5-minute window per author, so an agent making several quick edits in a row doesn't flood the history) — you don't need to call `create_doc_version` yourself unless you want a deliberately named checkpoint.

### Artifacts

Artifacts are first-class solution deliverables, separate from Markdown Docs. HTML content creates private immutable revisions; external URLs are stored but never server-fetched. Every mutation returns the stable Artifact identifier on a plain `ID: <uuid>` line.

| Tool | Description |
|---|---|
| `list_artifacts` | List active Artifacts in a workspace; pass `includeArchived: true` to include archived records |
| `get_artifact` | Return Artifact metadata, revision history, linked `solutions` and `decisions` without exposing private blob paths or uploaded HTML |
| `create_artifact` | Create `HTML_UPLOAD` from `html` plus an optional `.html` filename, or `EXTERNAL_LINK` from an `http`/`https` `url` |
| `update_artifact` | Update title/description and optionally create a new immutable HTML or URL revision |
| `link_artifact_to_solution` | Idempotently link an Artifact and Solution in the same workspace |
| `unlink_artifact_from_solution` | Remove an Artifact-to-Solution link |
| `link_artifact_to_decision` | Idempotently link an active Artifact to an ordinary tracked Decision in the same workspace; takes `workspaceId`, `artifactId`, `requestId` and returns those IDs, `linkId`, and `created` |
| `unlink_artifact_from_decision` | Idempotently remove a Decision link; takes `workspaceId`, `artifactId`, `requestId` and returns those IDs and `removed` |
| `archive_artifact` | Archive an Artifact while preserving its revision history and links |

Decision–Artifact links are live supporting material, not frozen review evidence. `get_decision` and `get_review_request` include an `artifacts` array with title, type, status, and current revision number; legacy review requests return an empty array. `get_artifact.decisions` includes the same-workspace tracked request ID, current title, and state. The new link tools require write access and validate both objects in the declared workspace. They preserve packets, fingerprints, revisions, cycles, and recorded outcomes. New links to archived Artifacts are rejected, but retrying an existing link and removing it remain supported. Links follow the stable Decision request and the current Artifact revision.

### Doc inline comments

Google-Docs-style comments anchored to a span of a doc's text (or left as a general, doc-level note). Threads are one level deep: a root comment optionally carries an anchor; replies attach to a root and never carry their own anchor. Anchors are stored separately and never embedded in the doc's markdown.

| Tool | Description |
| --- | --- |
| `add_doc_comment` | Add a comment to a doc. Params: `docId`, `body`, `authorName`, plus optional `parentId` (reply to a root comment) and optional anchor fields (`anchorText`, `anchorPrefix`, `anchorSuffix`, `anchorStart`, `anchorEnd`). Omit all anchor fields for a doc-level general comment. Replies never anchor. Returns the new comment's `ID:` line |
| `list_doc_comments` | List a doc's comments grouped into threads (roots with their replies), oldest-first. Params: `docId`, optional `status` (`OPEN` or `RESOLVED`) to filter |
| `get_doc_comment` | Return a single comment's full body, author, status, anchor context, and timestamps. Param: `commentId` |
| `update_doc_comment` | Edit a comment's body text (does not change status or anchor). Params: `commentId`, `body` |
| `delete_doc_comment` | Delete a comment. Deleting a root also deletes all of its replies. Param: `commentId` |
| `resolve_doc_comment` | Mark a comment `RESOLVED` — it drops out of the doc's default open-only view and stops highlighting. Param: `commentId` |
| `reopen_doc_comment` | Reopen a resolved comment, setting its status back to `OPEN`. Param: `commentId` |

Anchor offsets (`anchorStart`/`anchorEnd`) are positions in the doc's **plain-text projection**, not its raw markdown — the same projection the editor highlights against. In practice agents most often add doc-level or freshly-computed anchored comments; the UI is what captures precise anchors from a live text selection.

### Help

| Tool | Description |
|---|---|
| `search_help` | Full-text search over Compass's own product/usage documentation (the same content rendered at `/help/[slug]`); returns the best-matching doc section(s) with a `Path` pointer (deep-linking to a heading anchor when applicable) and a short excerpt. Not workspace-scoped |
| `get_help` | Resolve a free-text topic (a doc slug, title, or close match) to a single help doc and return its full raw markdown content plus its `/help/[slug]` path. Not workspace-scoped |

### Scoring

| Tool | Description |
|---|---|
| `list_scoring_models` | List an organization's scoring model templates (e.g. RICE, ICE) with status, formula type, version, and metric counts |
| `get_scoring_model` | Get full detail for a scoring model, including every metric's key, label, bounds, weight, and direction |
| `create_scoring_model` | Create a new org-level scoring model template with its metrics (WEIGHTED_SUM or MULTIPLICATIVE formula) |
| `update_scoring_model` | Update a scoring model's name/description and/or replace its metrics (replacing metrics bumps the model version) |
| `archive_scoring_model` | Archive a scoring model (hidden from new workspace selections, but existing usages remain valid) |
| `get_workspace_scoring_model` | Get the scoring model currently active for a workspace, including all its metrics |
| `set_workspace_scoring_model` | Set (or clear) the workspace's active scoring model |
| `score_opportunity` | Compute and save an opportunity's score using its workspace's active scoring model |
| `get_opportunity_score` | Get an opportunity's saved score, including a `stale` flag if the live model has since been updated |
| `list_top_opportunities` | List scored opportunities ranked by normalized score (0-100); pass `orgSlug` for a cross-workspace comparability view or `workspaceId` for a single workspace |

## Recency filtering and sorting

`list_opportunities`, `list_solutions`, `list_assumptions`, `list_experiments`,
`list_roadmap_items`, `list_tasks`, `list_docs`, `list_feedback`, and
`list_release_runs` accept an ISO `updatedSince` and/or `updatedBefore` window.
Most also accept `sort`, which takes `recentlyUpdated` (most recently updated
first) or `leastRecentlyUpdated` — the latter is for finding work that has gone
quiet, such as opportunities still EXPLORING or experiments parked in DESIGNING.

Omitting `sort` preserves each tool's own default ordering. Those defaults carry
meaning — `list_roadmap_items` groups by horizon then rank, `list_docs` renders a
parent/child tree, `list_tasks` orders by status then manual `sortOrder` — so
`sort` is an explicit opt-out rather than something to pass by habit. Recency
orderings always include a stable `id` tiebreaker, because `updatedAt` is not
unique and equal timestamps would otherwise return in an arbitrary order that can
differ between identical calls.

`list_feedback` is the exception worth reading closely: there `updatedSince`
starts a stable keyset scan paged by an opaque `cursor` (see the feedback section
above), rather than a simple filter.

### What `updatedAt` does and does not capture

Aurora DSQL has no trigger support, so `updatedAt` is maintained by the
application rather than the database. A Prisma client extension sets it on every
`update`, `updateMany`, and `upsert` — including writes inside a transaction — so
**direct edits to an object are always reflected**, and no individual call site can
forget.

**Mutating a child record does not mark its parent as updated.** A Solution is not
reported as recently updated when its plan is approved or rejected, when a comment
is added or resolved on it, or when evidence is attached to it. The same holds
for an Opportunity gaining a Solution, a Solution gaining an Assumption, an Experiment
gaining a result, and a Key Result gaining a check-in.

Agents should therefore **not conclude that a period was quiet from a recency
query alone.** Agent-driven work produces a high proportion of exactly these child
writes, so a recency scan can return nothing while the workspace was active.
Cross-check `list_comments`, `list_solution_comments`, `list_evidence`, and
`list_decisions` before reporting that nothing changed.

## Registered agent identities and task assignment

An agent-bound key identifies one personal agent across its explicitly granted
workspaces, including different organizations. The key owner must remain a
member of each workspace. See [Agents](/help/19-agents) for registration and grants.

| Tool | Purpose |
|---|---|
| `get_current_identity` | Inspect caller kind, registered agent identity, and effective accessible workspaces |
| `list_task_assignees` | Search and paginate eligible human and agent assignees in an authorized workspace |

`create_task` and `update_task` accept `assignee: { type: "USER" | "AGENT", id }`;
null clears an assignment and omission preserves it on update. Legacy
`assigneeUserId` remains supported, but supplying both forms is rejected.
`list_tasks` supports typed assignee filters and `assignedToMe: true`; conflicting
assignee filters are rejected. Service and unregistered runtime credentials
cannot use the “me” filter. Existing human assignee filter URLs remain supported.

Agent credentials cannot expand their own access or perform human approval
operations. Workspace lists and organization-wide rankings return only granted
workspaces. Registration, grants, and key management use authenticated settings.

Solution comments and plans created with agent credentials use the authenticated
agent's name and `AGENT` author type, overriding caller-supplied attribution.
Built-in assistant turns use “Compass assistant.” Agent credentials cannot call
`update_comment`, `update_doc_comment`, or `update_solution_comment`: existing
comment records do not have durable agent ownership, so agents must append a new
comment instead of rewriting one under someone else's name or approval badge.
Personal and service credential behavior is unchanged.

## Example: Connecting Claude Desktop

Add this to your Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "compass": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://your-compass-url.vercel.app/api/mcp",
        "--header",
        "Authorization:${MCP_AUTH_HEADER}"
      ],
      "env": {
        "MCP_AUTH_HEADER": "Bearer compass_your_api_key"
      }
    }
  }
}
```

`mcp-remote` supplies the Streamable HTTP transport headers, but callers must configure the `Authorization` header as shown above. Keeping the header value in `env` also avoids argument parsing problems with spaces in some MCP clients.

## Use Cases

- **Research synthesis** — Paste interview notes into your AI assistant and have it extract and create opportunities directly in Compass
- **Automated check-ins** — A scheduled agent that reads metrics from your analytics platform and creates KR check-ins
- **Experiment logging** — An agent that monitors your A/B testing platform and records experiment results when tests complete
- **Standup summaries** — An agent that reads your current roadmap and discovery board and generates a daily team update
