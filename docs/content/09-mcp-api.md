---
title: "MCP API"
description: "Integrate Compass into AI agents via the Model Context Protocol"
icon: "Zap"
order: 9
section: "Developer"
---

# MCP API

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

API keys are workspace-scoped. A key can read and write all data in the workspace it was created for. Treat API keys like passwords — rotate them in Settings if one is compromised.

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
| `list_opportunities` | Fetch all opportunities in the workspace, including each opportunity's description, status, squad, solution count, and linked Key Result |
| `get_opportunity` | Return full detail for an opportunity: solutions, assumptions per solution, and experiments linked to those assumptions |
| `create_opportunity` | Create a new opportunity with title, description, status |
| `update_opportunity_status` | Move an opportunity through its discovery pipeline: EXPLORING → VALIDATING → PRIORITIZED → ACTIVE → ARCHIVED |
| `link_opportunity_to_kr` | Associate an opportunity with a Key Result it is expected to move (or clear the link) |
| `add_solution` | Add a proposed Solution to an Opportunity |
| `update_solution_status` | Update a Solution's lifecycle status (IDEA/VALIDATED/IN_DELIVERY/SHIPPED/KILLED); any valid status may transition directly to any other valid status |
| `add_assumption` | Add a testable Assumption to a Solution, with a risk level (HIGH/MEDIUM/LOW); starts UNTESTED |
| `update_assumption` | Update an Assumption's title, risk level, or status (UNTESTED/TESTING/VALIDATED/INVALIDATED) |
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

### Experiments

| Tool | Description |
|---|---|
| `list_experiments` | Fetch all experiments |
| `get_experiment` | Return full details for a single experiment: hypothesis, method, kill condition, linked assumption, all logged results, and conclusion |
| `create_experiment` | Create a new experiment with hypothesis and method (starts in DESIGNING status) |
| `log_experiment_result` | Record an observation or data point for a running experiment |
| `conclude_experiment` | Conclude an experiment with PROCEED, KILL, or ITERATE; automatically updates the linked Assumption's status (PROCEED → VALIDATED, KILL → INVALIDATED, ITERATE → UNTESTED) |

### Roadmap

| Tool | Description |
|---|---|
| `list_roadmap_items` | Fetch active roadmap items for a workspace, grouped by horizon (including LAUNCHING/LAUNCHED), including start/end dates and whether each item is private (`isPrivate`) |
| `add_to_roadmap` | Create a roadmap item in NOW, NEXT, LATER, or SHIPPED, optionally with dates and an `isPrivate` flag |
| `update_roadmap_item` | Update a roadmap item's ordinary horizon, status, title, description, dates, or `isPrivate` flag. NOW behaves like other ordinary horizons; LAUNCHING/LAUNCHED use the launch workflow |
| `request_decision` | Request a tracking-only human decision linked to a workspace, Opportunity, Solution, Roadmap Item, Doc, Experiment, or Feedback item |
| `list_decisions` | List tracking-only decisions newest-first, optionally filtered by state, linked item type, outcome, reviewer, or search text |
| `get_decision` | Read one tracking-only decision and its immutable revision history |
| `request_release_authorization` | Prepare an immutable production-release review for one exact GitHub repository, PR number, base ref, 40-character head SHA, release-policy ID, and non-empty set of same-workspace Task IDs. This operation never takes the human decision or invokes release automation |
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

`apply_recorded_decision` is queue-only for release authorization. It validates
the authoritative provider snapshot outside the database transaction, then a
short transaction binds the unchanged snapshot and human decision to a durable
dispatch row. Compass does not merge, deploy, or otherwise invoke external
release automation in this implementation. Provider validation is unconfigured
by default and therefore fails closed (`PR_NOT_READY`); a dispatch worker must
use a configured provider and repeat the same head/check/policy revalidation at
the dispatch-claim boundary before any future external side effect.

### Squads

| Tool | Description |
|---|---|
| `create_squad` | Create a squad in a workspace with a name and optional six-digit hex color |
| `list_squads` | List all squads in a workspace with their IDs and colors |
| `get_squad` | Return a squad's ID, workspace ID, name, and color |
| `update_squad` | Update a squad's name and/or color |
| `assign_squad` | Assign a Squad to any object — opportunity, experiment, roadmap item, objective, or task (or clear it) |

### Tasks

Task is the standalone delivery/tracking entity used both for full engineering sprint delivery (replacing a Jira-style board) and lightweight PM initiative tracking — one status vocabulary, `BACKLOG → TODO → IN_PROGRESS → BLOCKED ⇄ IN_REVIEW → DONE`, with `CANCELLED` as a terminal state and `BLOCKED` a first-class column. Tasks link to other Compass objects (Opportunity, Solution, Roadmap Item, Objective, Key Result, Doc, Experiment, Feedback Item) many-to-many via `TaskLink`, and support Epic → Task → Subtask hierarchy via `parentTaskId`.

| Tool | Description |
|---|---|
| `create_task` | Create a Task with a title (required); optionally description, status (default TODO), priority (default MEDIUM), squad, parent task (to create a Subtask), assignee, freeform owner name, story points, due date, or iteration label |
| `get_task` | Return full detail for a Task: fields, parent Epic (if any), subtasks, and resolved links to other Compass objects |
| `list_tasks` | List tasks in a workspace, filterable by status, priority, squad, assignee, parent task (pass `null` for top-level Epics/tasks only), or a linked object; optionally nest subtasks under their parent |
| `update_task` | Update a Task's title, description, priority, assignee, owner, story points, due date, or iteration — does not accept status |
| `move_task_status` | Dedicated status-transition tool for a Task, including moving it into or out of BLOCKED |
| `link_task` | Link a Task to another Compass object; idempotent — re-linking the same pair is a no-op |
| `unlink_task` | Remove a link between a Task and another Compass object |
| `list_task_links` | List all links for a Task, grouped by linked object type with resolved titles |

### Feedback

| Tool | Description |
|---|---|
| `create_feedback` | Create a new feedback item directly via MCP. Accepts 1–5 optional inline attachments with a combined decoded limit of 3 MiB; defaults to type IDEA |
| `list_feedback` | Fetch customer feedback items for a workspace, with vote counts, type, status, and canonical Compass URLs |
| `get_feedback_item` | Fetch full details for a single feedback item, including attachments, its linked opportunity, and its canonical Compass URL |
| `update_feedback` | Update a feedback item's title and/or description; pass `description: null` to clear it |
| `update_feedback_status` | Update a feedback item's status (OPEN, UNDER_REVIEW, PLANNED, IN_PROGRESS, COMPLETED, DECLINED), with an optional note. Legacy CLOSED remains temporarily accepted but is deprecated |
| `update_feedback_type` | Reclassify a feedback item as a BUG or an IDEA |
| `link_feedback_to_opportunity` | Link a feedback item (typically an IDEA) to an existing opportunity, connecting it to the discovery flow |
| `prepare_feedback_attachment_upload` | Prepare a signed, short-lived direct-to-Vercel-Blob upload for an attachment up to 10 MiB |
| `add_feedback_attachment` | Add one inline attachment to existing feedback, or complete a prepared direct upload using its Blob URL and signed receipt |
| `promote_feedback_to_roadmap` | Promote a feedback item (typically a BUG) directly to the roadmap, skipping discovery entirely. Accepts an optional `isPrivate` flag (e.g. for a security-flagged bug) |

Feedback create, read, list, update, status, type, link, and attachment responses include absolute canonical URLs that agents can give directly to users. Preview MCP responses point to the active Vercel branch/deployment URL, while production uses the configured Compass custom domain. Every feedback mutation also includes its affected entity ID on a plain `ID: <uuid>` line.

For screenshots and other small files, pass a base64 data URL (or raw base64 plus `fileType`) directly to `create_feedback` or `add_feedback_attachment`. Compass validates the encoded length before decoding and rejects the entire create request if any attachment cannot be uploaded; it never silently creates text-only feedback.

For files larger than the 3 MiB inline aggregate limit, use the two-step direct upload flow:

1. Call `prepare_feedback_attachment_upload` with the workspace, filename, MIME type, and exact file size (maximum 10 MiB).
2. Upload the file directly with `put(pathname, file, { access: "public", token: clientToken, contentType: fileType })` from `@vercel/blob/client`, using the returned pathname and client token.
3. Call `add_feedback_attachment` with the target feedback ID, returned Blob URL, and signed receipt.

The receipt expires after ten minutes and is scoped to the workspace, prepared attachment ID, pathname, MIME type, and byte size. Compass verifies the receipt, configured Blob store, and Blob metadata before creating the attachment row. The prepared ID makes concurrent completion idempotent; an ID already committed to another feedback item is rejected. Each feedback item accepts at most five attachments, enforced transactionally.

### Evidence

| Tool | Description |
|---|---|
| `add_evidence` | Attach a piece of evidence (interview, feedback, support ticket, experiment result, or analytics) to an opportunity, solution, or assumption |
| `link_evidence` | Re-parent existing evidence to a different opportunity, solution, or assumption |
| `list_evidence` | Fetch all evidence attached to a given opportunity, solution, or assumption |

### Docs

| Tool | Description |
|---|---|
| `list_docs` | List all docs in a workspace as an indented tree; use to discover doc IDs before calling `get_doc` or `update_doc` |
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
| `get_artifact` | Return Artifact metadata, revision history, and linked Solutions without exposing private blob paths or uploaded HTML |
| `create_artifact` | Create `HTML_UPLOAD` from `html` plus an optional `.html` filename, or `EXTERNAL_LINK` from an `http`/`https` `url` |
| `update_artifact` | Update title/description and optionally create a new immutable HTML or URL revision |
| `link_artifact_to_solution` | Idempotently link an Artifact and Solution in the same workspace |
| `unlink_artifact_from_solution` | Remove an Artifact-to-Solution link |
| `archive_artifact` | Archive an Artifact while preserving its revision history and links |

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
