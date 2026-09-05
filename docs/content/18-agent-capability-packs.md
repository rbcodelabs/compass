---
title: Agent capability packs
description: Install validated instruction packs for the Compass in-app agent
---

# Agent capability packs

Workspace administrators can add reusable skills to the Compass in-app agent from **Settings → Agent capability packs**.

Enter a public GitHub repository URL, a full 40-character commit SHA, and the path containing the pack. Compass validates the content before attaching it. Installed versions are immutable: to upgrade, install another commit and select its version; to roll back, select an earlier version.

Each pack must contain a `compass-pack.json` manifest and one or more declared `skills/<skill-id>/SKILL.md` files. Skills may reference bundled Markdown, text, JSON, YAML, CSV, SVG, PNG, JPEG, or WebP assets. Packs are limited to 1 MiB, 20 skills, and 256 KiB per file.

Capability packs add instructions, not authority. They cannot add shell or filesystem access, external websites, secrets, hooks, commands, subagents, or MCP servers. Compass remains the only tool provider and applies the signed-in user's existing workspace permissions to every action.

## Agentic PM Playbook pack interface

The Playbook repository's Compass edition should live at `packs/compass/` and include a schema-version 1 manifest. Its cloud skills must use the active workspace ID supplied by Compass, operate through Compass MCP only, and return reports in the conversation. They must not read `pm-config.md`, request API keys, spawn agents, or fall back to Obsidian, Jira, GitHub, Vercel, shell, or local files.

For the status-report workflow, the assistant response and existing conversation history are the v1 archive. A separate report datastore is not required.
