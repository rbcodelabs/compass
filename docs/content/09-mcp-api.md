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

## What Agents Can Do

The MCP server exposes tools that agents can call, grouped below by area.

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
| `get_okr_cycle` | Return a full OKR cycle with all objectives and their key results, including current progress |
| `create_objective` | Create a new Objective inside an OKR cycle; optionally assign a squad or link to a parent KR it supports |
| `add_key_result` | Add a Key Result to an existing Objective |
| `log_checkin` | Record a progress check-in for a Key Result and update its current value |
| `set_objective_parent_kr` | Link a squad objective to the company-level Key Result it is supporting (or clear the link) |

### Discovery — Opportunities, Solutions, Assumptions

| Tool | Description |
|---|---|
| `list_opportunities` | Fetch all opportunities in the workspace |
| `get_opportunity` | Return full detail for an opportunity: solutions, assumptions per solution, and experiments linked to those assumptions |
| `create_opportunity` | Create a new opportunity with title, description, status |
| `update_opportunity_status` | Move an opportunity through its discovery pipeline: EXPLORING → VALIDATING → PRIORITIZED → ACTIVE → ARCHIVED |
| `link_opportunity_to_kr` | Associate an opportunity with a Key Result it is expected to move (or clear the link) |
| `add_solution` | Add a proposed Solution to an Opportunity |
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
| `add_to_roadmap` | Create a roadmap item in NOW/NEXT/LATER/SHIPPED, optionally with a start date and end date for the Timeline view, and an `isPrivate` flag to hide it from the public portal roadmap and block voting on it |
| `update_roadmap_item` | Update a roadmap item's horizon, status, title, description, start/end dates, or `isPrivate` flag. Rejects `horizon: LAUNCHING`/`LAUNCHED` — use `set_launch_tier` to move an item into LAUNCHING |
| `create_checklist_template` | Create a reusable launch checklist template for a workspace, scoped to a launch tier (TIER_1/TIER_2/TIER_3), with an ordered list of items |
| `list_checklist_templates` | List a workspace's checklist templates, optionally filtered by launch tier |
| `set_launch_tier` | Move a roadmap item into the LAUNCHING horizon by picking a launch tier; attaches a checklist cloned from an explicit or auto-resolved (most recent ACTIVE) template for that tier. Rejects items already LAUNCHING/LAUNCHED |
| `get_launch_checklist` | Get the launch checklist for a roadmap item, including each item's status and ID |
| `update_launch_checklist_item` | Set a launch checklist item's status (PENDING/DONE/SKIPPED) |

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
| `list_feedback` | Fetch customer feedback items for a workspace, with vote counts, type (BUG/IDEA), and status |
| `get_feedback_item` | Fetch full details for a single feedback item, including its linked opportunity if present |
| `update_feedback_status` | Update a feedback item's status (OPEN, UNDER_REVIEW, PLANNED, CLOSED), with an optional note |
| `update_feedback_type` | Reclassify a feedback item as a BUG or an IDEA |
| `link_feedback_to_opportunity` | Link a feedback item (typically an IDEA) to an existing opportunity, connecting it to the discovery flow |
| `promote_feedback_to_roadmap` | Promote a feedback item (typically a BUG) directly to the roadmap, skipping discovery entirely. Accepts an optional `isPrivate` flag (e.g. for a security-flagged bug) |

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
      "args": ["-y", "mcp-remote", "https://your-compass-url.vercel.app/api/mcp"],
      "env": {
        "MCP_AUTH_HEADER": "Authorization: Bearer compass_your_api_key"
      }
    }
  }
}
```

## Use Cases

- **Research synthesis** — Paste interview notes into your AI assistant and have it extract and create opportunities directly in Compass
- **Automated check-ins** — A scheduled agent that reads metrics from your analytics platform and creates KR check-ins
- **Experiment logging** — An agent that monitors your A/B testing platform and records experiment results when tests complete
- **Standup summaries** — An agent that reads your current roadmap and discovery board and generates a daily team update
