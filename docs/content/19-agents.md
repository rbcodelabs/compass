---
title: Agents
description: Create cloud agents, choose which one answers, and connect external agents with one key
icon: "Bot"
order: 19
section: "Core Features"
---

# Agents

Register an external assistant as a named agent so it can receive tasks and
identify its actions in Compass. Each agent belongs to your account and can
work across approved workspaces, including workspaces in different organizations.
You configure one agent key in your MCP client.

## Register and connect

1. Open **My agents** from your account or API-key settings.
2. Create an agent with a recognizable name, such as “Engineering assistant.”
3. Ask a workspace administrator to enable it under **Workspace agents**.
4. Generate a key for the agent and copy it when shown. Compass never shows the secret again.
5. Configure your existing MCP client with the Compass endpoint and that key.

The same key works in every workspace where the agent has an active grant and
you remain a member. Adding or removing a workspace grant does not require a new
key. An agent can be registered and assigned tasks before you generate a key.

Existing personal API keys remain personal credentials — they carry your full
access across every workspace you belong to, administrative permissions included.
An agent key is deliberately narrower: it reaches only granted workspaces, cannot
administer anything, and can be revoked without disturbing your own access. Prefer
an agent key whenever an AI assistant is doing the calling, and reserve your
personal key for work you operate yourself. See
[Identity and Access](/help/21-identity-and-access) for the full comparison.

![Account-wide agent settings](/screenshots/docs/agents-desktop.png)

## Cloud agents

A **cloud agent** runs inside Compass, in the same sandbox as the chat assistant, with
instructions and a model that you choose. It is a named identity: it can be assigned
tasks, shows up in Workspace > Agents, and its activity is attributed to it. External
agents (above) connect from your own tooling with a key; cloud agents need no key.

Create one from **Workspace settings > Workspace agents > New cloud agent**:

- **Personal** agents belong to you. Any workspace member can create one, and only the
  owner can run it. A workspace administrator must enable it in the workspace (it is
  enabled for you automatically if you are the administrator).
- **Shared** agents belong to the workspace. Only a workspace administrator can create
  one. The administrator who creates it grants it read-only or read-and-write access,
  and chooses who may run it: any workspace member, or administrators only.

The **Instructions** guide the agent. They cannot widen its access: a cloud agent
reaches only what it was granted, and a personal agent is further limited to what its
owner can do. The **Model** list shows the models your deployment allows; leave it on
the system default if unsure. Edit an agent's instructions, model and (for shared
agents) who can run it from the same panel, or from **My agents** for personal ones.

### Which agent answers

Chat and **Send to agent** use the first of these that applies:

1. the agent you pick in the chat's **Agent** menu (or in the Send to agent menu);
2. your **personal default** ("Use as my default" on an agent you can run);
3. the **workspace default** an administrator sets on a shared agent;
4. the built-in **Compass Agent**.

A default that is no longer usable (the agent was suspended, lost its workspace
access, or you may no longer run it) is skipped silently and the next one applies, so
revoking access can never break anyone's chat. Pick **Compass Agent** in the menu to
use the built-in assistant for one conversation regardless of defaults. Defaults need
the cloud-agent database update (migrations 100 and 101); until then the built-in
agent answers.

Administrators can create the shared Compass Agent for chosen workspaces with
migration `103_shared_compass_agent_bootstrap`. It never runs on its own: name the
workspaces in `COMPASS_SHARED_AGENT_WORKSPACE_IDS` and run it by name. It is safe to
repeat and never overrides an existing default or revives a revoked grant.

## Workspace access

Workspace administrators, or organization administrators with workspace access,
choose which members' agents can operate in the workspace:

- **Read:** inspect permitted workspace data.
- **Write:** also perform ordinary product and task updates.

Agent access never exceeds its owner's current access. Agents cannot manage
memberships, keys, grants, or human approvals. New workspaces do not automatically
enable your agents, with one exception: if your agent creates a workspace (it may,
while you are an organization owner or admin), it is given Write access to that
workspace, recorded as granted by you. Removing a member revokes their agents' workspace grants;
rejoining requires an administrator to grant access again.

Agents can add comments and plans, but cannot rewrite existing comments. Append
a correction instead; this preserves the original author's attribution.

Research study and participant-link tools currently require a human or service
key; registered-agent and built-in assistant keys cannot call them.

![Workspace agent access](/screenshots/docs/workspace-agents-desktop.png)

## Assign a task

Use the task's **Assignee** picker to select a person or agent. A task has one
assignee, or can be unassigned. The board, list, detail page, and roadmap delivery
panel display the same identity. Assignee filters include people and agents.

Assignment records who should do the work. It does not grant access. Cloud agents
appear in the picker once they are enabled in the workspace. Assigning a task does not
start a cloud agent yet; run it from chat. Your MCP client or automation decides when
an external agent executes.

If an agent is suspended or loses access, existing assignments remain visible as
unavailable. Clear or reassign them explicitly. The external Owner label remains
a separate descriptive field.

![People and agent assignee picker](/screenshots/docs/tasks-agents-desktop.png)

## Keys and suspension

Generate a replacement key, update your client, then revoke the old key. Rotation
does not change the agent's identity or assignments. You can give keys an expiry;
otherwise external agent keys remain valid until revoked or access is removed.

Suspending your agent stops its subsequent requests everywhere. A workspace
administrator can instead revoke just that workspace's grant.

## Activity

Agent activity shows mutation attempts and their outcomes. A started operation
without a recorded final result has an unknown outcome; check the affected data
before retrying. A successful operation means Compass processed the tool request,
not that the task's underlying work is complete.

When a cloud agent runs on someone's behalf, each row names the agent and shows who
invoked the run. A shared agent acts only through the workspace access it was
explicitly granted; it never gains the rights of the person who started the run,
and its access ends as soon as the run does.

Activity is scoped to the viewer's current workspace access. Raw tool arguments
and API key secrets are not included.

## MCP discovery

Use `get_current_identity` to inspect the authenticated identity and accessible
workspaces. Use `list_task_assignees` to find assignable people and agents.
Pass `assignedToMe: true` to `list_tasks` to find the registered agent's tasks.

For task creation or reassignment, use:

```json
{ "assignee": { "type": "AGENT", "id": "<agent UUID>" } }
```

Use `"USER"` for a person or `"assignee": null` to clear the assignment.
Do not send both `assignee` and the legacy `assigneeUserId` field.

## Deployment

Administrators must apply and verify migration `049_agent_identity` before
this revision receives user traffic, then enable `COMPASS_AGENTS_ENABLED=1`. Cloud agents
additionally need migrations `098`, `099`, `100` and `101`; the code tolerates any of
them being unapplied (cloud-agent features stay unavailable and chat uses the built-in agent).
`COMPASS_CLOUD_AGENT_MODELS` (comma-separated) adds models to the allowed list.
The flag is not a substitute for installing the schema. Turning off new agent operations preserves
existing assignment records. The built-in Compass Agent is not itself a task assignee;
create a shared cloud agent if you want one.
