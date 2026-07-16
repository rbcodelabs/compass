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

The MCP server exposes tools that agents can call:

| Tool | Description |
|---|---|
| `list_opportunities` | Fetch all opportunities in the workspace |
| `create_opportunity` | Create a new opportunity with title, description, status |
| `update_opportunity` | Update status, description, or squad assignment |
| `list_experiments` | Fetch all experiments |
| `create_experiment` | Create a new experiment with hypothesis and method |
| `update_experiment` | Record results or update experiment status |
| `list_okrs` | Fetch cycles, objectives, and key results |
| `create_key_result_checkin` | Log a progress check-in for a Key Result |
| `list_feedback` | Fetch customer feedback items for a workspace, with vote counts, type (BUG/IDEA), and status |
| `get_feedback_item` | Fetch full details for a single feedback item, including its linked opportunity if present |
| `update_feedback_status` | Update a feedback item's status (OPEN, UNDER_REVIEW, PLANNED, CLOSED), with an optional note |
| `update_feedback_type` | Reclassify a feedback item as a BUG or an IDEA |
| `link_feedback_to_opportunity` | Link a feedback item (typically an IDEA) to an existing opportunity, connecting it to the discovery flow |
| `promote_feedback_to_roadmap` | Promote a feedback item (typically a BUG) directly to the roadmap, skipping discovery entirely |
| `list_roadmap_items` | Fetch active roadmap items for a workspace, grouped by horizon, including start/end dates when set |
| `add_to_roadmap` | Create a roadmap item in NOW/NEXT/LATER/SHIPPED, optionally with a start date and end date for the Timeline view |
| `update_roadmap_item` | Update a roadmap item's horizon, status, title, description, or start/end dates |

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
