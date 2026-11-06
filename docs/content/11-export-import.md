---
title: "Export and import"
description: "Back up a workspace, or copy or move it to another organization"
icon: "Download"
order: 11
section: "Configuration"
---

# Export and import

A workspace can be exported to a single file and imported again as a new workspace. Use it to keep a backup, to make a working copy, or to move a workspace into a different organization.

## Exporting a workspace

Go to **Settings → Export** and click **Download workspace bundle**. Exporting needs workspace Admin (or an Owner/Admin of the organization).

The bundle is a standard `.zip` file. It contains everything in the workspace:

- OKRs, opportunities, solutions, assumptions, experiments, roadmap items, tasks and their links
- Docs and their version history, comments, artifacts and their files, doc images
- Feedback, research studies, sessions and attachments, decisions, metrics, card sorts
- Custom fields, squads, saved views, modules and other settings

The bundle never contains passwords, API keys, SSO or Anthropic keys, share links, sign-in sessions, or agent run history. Workspace-owned agents and capability packs are included; private agent conversations are not.

Workspaces that use Geode-hosted documents cannot be exported yet.

## Importing a bundle

Go to **Organization Settings → Import workspace**, optionally give the new workspace a name and URL slug, choose the bundle file and click **Import workspace**. Importing needs an Owner or Admin of the organization. Large imports can take a few minutes — keep the page open.

An import always creates a **new** workspace; nothing that already exists is changed. If anything goes wrong, the partly imported workspace is removed again and no trace is left.

What to expect in the new workspace:

- **Numbers are kept.** Work-item numbers such as `OPP-42` stay the same, so references in docs still make sense, and new items continue after the highest imported number.
- **People are matched by email.** Anyone in the bundle who is also a member of the target organization keeps their attribution. Everyone else is attributed to the person who ran the import.
- **Secrets are not carried over.** SSO is switched off, analytics connections arrive disabled, and share links, feedback keys and research links must be created again.
- **Some items are skipped and reported.** A link pointing at something outside the bundle, or a score that uses a scoring model from another organization, is left out. The result panel lists what was skipped.
- **Everyone in the organization is added** to the new workspace, and you become its Admin.

Importing the same file again creates a second, separate copy.
