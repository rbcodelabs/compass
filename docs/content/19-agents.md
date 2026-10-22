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

1. the agent you pick with the **Agent** chip under the message box (or in the Send to agent menu);
2. your **personal default** ("Use as my default" on an agent you can run);
3. the **workspace default** an administrator sets on a shared agent;
4. the built-in **Compass Agent**.

A default that is no longer usable (the agent was suspended, lost its workspace
access, or you may no longer run it) is skipped silently and the next one applies, so
revoking access can never break anyone's chat. Pick **Compass Agent** in the Agent list to
use the built-in assistant for one conversation regardless of defaults. Defaults need
the cloud-agent database update (migrations 100 and 101); until then the built-in
agent answers.

Administrators can create the shared Compass Agent for chosen workspaces with
migration `103_shared_compass_agent_bootstrap`. It never runs on its own: name the
workspaces in `COMPASS_SHARED_AGENT_WORKSPACE_IDS` and run it by name. It is safe to
repeat and never overrides an existing default or revives a revoked grant.

### Which model answers

The message box is one card. Its footer holds two labelled chips, **Agent** and **Model**; each opens a list (a bottom sheet on a phone). Use the arrow keys to move through a list, **Enter** to choose and **Esc** to close it. The Model chip uses the first of these that applies:

1. the model you pick with the **Model** chip for this message;
2. the model set on the agent that answers (see **Model** when you create or edit a cloud agent);
3. the deployment's default model.

The **Default** entry always names what it currently resolves to, for example
"Default (Claude Sonnet 5)", and changes with the agent you select until you pick a
model yourself. Your pick is remembered in this browser for this workspace; if that
model is later removed from the allowed list, the chip goes back to Default. Choosing a
model changes only which model answers: the agent's instructions, tools and access are
unchanged. The model a run is using is shown in the message box while it runs
(for example "Triage is answering on Claude Opus 9"; the chips lock until the run ends and **Esc** stops it) and is recorded on the run.

The Model list shows the models in the allowed list (the same list the agent form uses; see
**Deployment**). It does not appear when there is nothing to choose, and it is not
offered when the deployment runs on Amazon Bedrock, whose model ids differ from the
Anthropic API's: there the deployment's configured model always answers, and a request
that names a model is refused. The server checks every pick against the allowed list,
so a hand-edited request cannot run an unlisted model. Runs started by assigning a
task or by an @mention keep using the agent's own model.

Things to know about models:

- Every model in the allowed list, including each one added with
  `COMPASS_CLOUD_AGENT_MODELS`, can be chosen by any member who can chat in the
  workspace. The allowed list is therefore also the list of models you are willing to pay
  for per message. Usage limits are checked before a turn and charged after it, so a
  single turn on an expensive model can overshoot the daily cost cap by one turn.
- A failed, interrupted or cancelled run now keeps the model it was started with (it
  used to be blank), so you can see which model a failed run used.
- The model saved on an agent is checked for shape only, not against the allowed list, so
  an agent can still run a model that was later removed from the list or typed by hand
  elsewhere. Only the model picked in chat is checked against the allowed list.
- If you send a message in the first moment after the page opens, before the lists have
  loaded, the message uses Default; a remembered model is applied once the lists arrive.

### Things to know before you share an agent

- **A run outlives the membership of the person who started it, until its deadline.**
  Removing someone from a workspace stops them starting new runs and revokes access to
  the conversation, but a run already in progress keeps going (up to 20 minutes) with the
  agent's own grants. A shared agent's grants are re-checked on every request, though: if
  the administrator who issued a grant stops administering the workspace, or you revoke
  the grant, the agent loses that access immediately, mid-run. To stop a run right away,
  suspend the agent or revoke its workspace access.
- **The shared Compass Agent becomes the workspace's default chat agent.** The
  bootstrap (migration `103`) makes it the workspace default when none is set, so
  everyone's chat and Send to agent use it until they pick another. It acts only through
  its own grants, not each person's access, so check what it was granted before you run
  the bootstrap.
- **Do not give an organization-admin grant to an agent that any workspace member may
  run.** An organization-admin grant lets the agent do administrator-level work, and a
  shared agent whose invoke policy is "Any workspace member" lets every member direct it.
  Today the product refuses this combination (a shared agent cannot be granted
  organization-admin access at all, and a personal agent can be run only by its owner);
  if that ever changes, restrict such an agent to "Workspace admins only".

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
appear in the picker once they are enabled in the workspace. Your MCP client or
automation decides when an external agent executes.

### Assigning to a cloud agent starts a run

When you assign a task to a **cloud agent** in the app, Compass also starts a run as
that agent, and tells you so ("Started a run as Triage") with a link to follow it in
a conversation named after the task. The same happens when you @mention a cloud agent
in a Doc comment that creates a task, and the agent is given the comment as context.
This covers creating a task with an agent assignee, changing a task's assignee (on the
board, the list, the detail panel, or a task linked from another object), and the
Doc comment flow.

The run is attributed to the agent and to **you** as the person who started it. It can
use only what the agent was granted in this workspace, never your own access, and it
ends when the run does. The conversation is an ordinary one, so you can reply to the
agent there afterwards.

The assignment is always saved. If the run cannot start, the task is still assigned
and you are told why:

- you are not allowed to run that agent (a personal agent can be run only by its owner;
  a shared agent follows its "Who can run this agent" setting);
- the agent is suspended or no longer enabled in this workspace;
- the agent has reached a run limit (below), or you have reached your own daily agent limit;
- background agent runs are not set up on this deployment.

Saving the same assignee again, or editing a comment, never starts a second run, and a
task that already has a run in progress for you starts no second one ("already working
on this task"). An **external** agent is unchanged: assignment only queues the task for it.

Only assignments made by a person in the app start a run. Assigning through the MCP
tools or the REST API (`create_task`, `update_task`), decision follow-through and other
automatic changes record the assignment and nothing more: the caller could itself be an
agent, and agents assigning each other would otherwise start runs nobody asked for.

### Run limits

Each cloud agent has two limits, so a busy or runaway agent cannot use unbounded capacity:

- **Concurrent run limit:** runs of this agent in progress at once (default 5);
- **Daily run limit:** runs it may start in any 24 hours, whatever their outcome (default 100).

A person who can manage the agent sets them under **Edit** (whole numbers up to 50 and
5000); leave a field empty for the default. When a limit is reached, a new run is refused
with a message that names the limit: in chat as a clear error, and for an assignment as
a notice, with the assignment itself kept. Limits are counted per agent, so one agent
never uses another's allowance. Your own daily agent limit still applies on top.

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
additionally need migrations `098`, `099`, `100`, `101` and `102` (the run-limit columns); the code tolerates any of
them being unapplied (cloud-agent features stay unavailable and chat uses the built-in agent; without `102`
every agent simply uses the default limits and the limit fields cannot be saved).
Assignment-started runs also need background agent runs (migration `069`) and a built agent runtime snapshot.
`COMPASS_CLOUD_AGENT_MODELS` (comma-separated) adds models to the allowed list.
The flag is not a substitute for installing the schema. Turning off new agent operations preserves
existing assignment records. The built-in Compass Agent is not itself a task assignee;
create a shared cloud agent if you want one.
