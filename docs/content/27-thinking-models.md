---
title: "Thinking models"
description: "Choose how your workspace names and relates Objectives, Key Results, Opportunities, Solutions and Cycles"
icon: "Lightbulb"
order: 27
section: "Core Features"
---

# Thinking models

A **thinking model** is a workspace setting that decides how Compass *names* and *presents* the same five things: Opportunities, Objectives, Key Results, Solutions and Cycles. It changes words and a few screens. It never changes your data, so you can switch models at any time and nothing is migrated or deleted.

Only a workspace admin can change it: open **Settings**, find **Thinking model**, pick a model and select **Save**. An organization admin who is not a member of the workspace cannot change it.

Compass stores only the name of the model you pick (plus any renames of the five entities, described below). A workspace that never chose one, or whose setting is blank, uses **Classic OKRs** forever, and Classic stays selectable at any time.

## The three models

| Model | What it is | Words | Extra screens |
|---|---|---|---|
| **Classic OKRs** (the default) | Compass as it has always worked. Every workspace that never chose a model uses it, and always will. | Objective, Key Result | None |
| **Opportunity-first OKRs** | Opportunities are the whole landscape of needs. You choose which ones to pursue by linking them to Objectives. | Same as Classic | A workspace tree that starts from a pool of opportunities, and the Objectives picker on each opportunity |
| **Torres opportunity solution tree** | An Objective is the *outcome* at the root of a tree. Key Results become that outcome's success metrics. | **Outcome** for Objective, **Success metric** for Key Result | A workspace tree rooted on outcomes, a flat list of all outcomes on the Outcomes page, and the Outcomes picker on each opportunity |

Under Torres the OKRs entry in the sidebar is called **Outcomes**, and the new words appear wherever those names are shown: the OKR pages, the canvas, the Discovery board, table and swimlane, the opportunity and solution panels, decisions and reviews, measurements, search, roadmap and task screens.

### What does not change

- Your Objectives, Key Results, Opportunities, Solutions, cycles and links are the same under every model.
- Agents and API tools always use the standard names (Objective, Key Result), whatever your workspace calls them.
- The places listed under [What still uses the standard names](#what-still-uses-the-standard-names) keep them under every model and every rename.
- A Classic workspace sees no new screens, and its text is exactly what it was before names became a setting. (Its admins do see the rename fields in Settings, which stay empty until someone fills them in.)

## Renaming your entities

On the same Settings section you can give any of the five entities (**Opportunity**, **Objective**, **Key Result**, **Solution** and **Cycle**) a workspace-specific name. Each has a singular and an optional plural; if you leave the plural empty Compass derives one ("Bet" becomes "Bets", "Story" becomes "Stories", "Focus" becomes "Focuses"), so type the plural when the guess would be wrong ("Hero" would become "Heros"). Leave a field empty to keep the model's own name.

- Letters, numbers, spaces and `' ’ & / -` only, starting with a letter or number, up to 32 characters each, and the whole set must stay within 1 KB.
- A name cannot be the name of a section in the navigation (Roadmap, Discovery, Docs and so on) or of another thing Compass names (Experiment, Assumption, Evidence, Squad, Task, Artifact and similar), and no two entities can share a name or a plural. That includes entities you did not rename: you cannot call Solutions "Opportunities" unless you also rename Opportunity.
- A rename replaces the model's own word. Under Torres, renaming Objective to "Aim" gives **Aim** everywhere, not Outcome.
- A rename carries no "a" or "an", because the right one depends on the word. Compass's own words read "Link to an opportunity…"; with Opportunity renamed to "Idea" it reads "Link to idea…".
- A workspace that renames a Cycle sees that word in the cycle forms and cards, the cycle page, the Objective panel's Cycle field and the canvas zoom label.

Renaming changes words only. You cannot define your own hierarchy or new kinds of link.

## The workspace tree

Under Opportunity-first and Torres, **Discovery** has a tree button, named **Outcome tree** under Torres and **Objective tree** under Opportunity-first. It opens a tree for the whole workspace. Classic workspaces do not have this page.

**Torres (outcome-rooted):**

- Each outcome is a card. Its success metrics sit in a scrollable strip across the top: they are measures, not branches.
- Under the outcome are the opportunities you linked to it, and under each opportunity its solutions.
- A solution shows a chip for each success metric it targets. If that metric belongs to an outcome the opportunity is *not* linked to, the chip also names that outcome, so a cross-outcome aim is visible rather than hidden.
- An opportunity linked to several outcomes shows its full branch once, under the first of them. Under the others you see a short **Also under …** line with a **Show** button that expands the same branch. Counts at the top of each card count each opportunity and solution only once.
- Opportunities linked to no outcome are collected at the bottom under **Opportunities not linked to outcomes**. Archived opportunities are left out.
- A small chip shows the cycle the outcome belongs to, only if it has one: an outcome with no cycle is a normal part of the tree and shows no chip. An outcome that supports a key result of another outcome shows a **Supports …** chip; it is not nested.

**Opportunity-first (pool first):** the pool of unlinked opportunities comes first, then each Objective with its Key Results; each Key Result lists the solutions aimed at it, and solutions that target none of its Key Results are listed separately.

If an opportunity has no link but its **Driving Key Result** is set, it is placed under that Key Result's Objective, so older data does not fall into the pool.

## The Outcomes list (Torres)

On the **Outcomes** page a flat list of every outcome appears above the cycles. Each row shows the status, the number of linked opportunities, and a chip for its cycle where it has one. You do not need to open a cycle first to see them, and outcomes with no cycle are in the list like any other.

## Cycles under each model

An Objective's cycle is optional under every model. An Objective with no cycle is a persistent goal that is not tied to a planning period; it still counts as an Objective everywhere (the workspace tree, link pickers, card sorts, agents).

- **Classic and Opportunity-first.** The OKRs page shows an extra **No cycle / Persistent** card after the cycle cards. It opens the page at `/okrs/none`, which lists those Objectives and has the usual **+ Add Objective** form. An Objective's panel shows **No cycle / Persistent** in its Cycle field. Classic reads exactly as it did before the cycle became optional.
- **Torres.** Cycles are subdued: they are never required and never prominent. The Outcomes list already shows every outcome, so there is no **No cycle / Persistent** card, and an outcome's panel shows a cycle only when it has one. The cycle cards are still there for outcomes that have cycles, and a quiet link under them (**Or add an Outcome with no cycle**) opens `/okrs/none` to create one without a cycle. If the workspace has no cycles and no outcomes yet, the empty state offers the same link.

Renaming Objective changes these words too: with Objective renamed to "Goal", the link reads **Or add Goal with no cycle** (a rename carries no "a" or "an").

## Linking an opportunity to Outcomes or Objectives

On an opportunity's page or panel, under Opportunity-first and Torres, an **Outcomes** (or **Objectives**) box lists what the opportunity is linked to. Once the workspace has at least one, select **Change** (or **Link outcomes** when there are none), then tick or untick items. Each tick saves immediately. An opportunity can serve several.

If a link exists only because the opportunity's **Driving Key Result** sits under that Objective, unticking it explains that it is still linked through the Key Result; change the Key Result to remove it.

You need to be a member of the workspace. Linking is the same data whatever the model, so agents can read and change the same links with the link tools described in the [MCP API](/help/09-mcp-api#typed-links) page.

## Linking a solution to Key Results

A solution can also be linked to the Key Results (success metrics) it is meant to move; it still belongs to exactly one opportunity. Under Opportunity-first and Torres, open the solution and use its **Linked Key Results** box (**Linked Success metrics** under Torres): select **Change** (or **Link key results** when there are none), then tick or untick any Key Result in the workspace. Each tick saves immediately, and you need to be a member of the workspace. The Key Result's own panel has a read-only **Linked Solutions** list, each row opening that solution. Classic workspaces have neither box. The workspace tree and the [Canvas](/help/12-canvas) draw these links, and agents make and read them with `link_solution_to_key_result`, `unlink_solution_from_key_result` and `list_links`.

## What still uses the standard names

These are the only places that keep Compass's standard names (Opportunity, Objective, Key Result, Solution, Cycle) under every model and after every rename. The list in Settings is built from the same source as this one.

- **Agent (MCP) tools, their descriptions and their output text, and the API.** Agents and integrations rely on one stable vocabulary. The workspace's names reach agents only as structured data (`thinkingModel.labels`), never inside prose.
- **The public portal, shared roadmaps, embeds and the marketing site.** These are seen by people outside the workspace, who do not share its vocabulary.
- **Help and documentation text (other than the thinking models page itself).** Help describes the product as it ships, in its standard terms.
- **Research studies, the PM interview, the voice agent and the agent chat.** Their prompts and generated copy are written for agents and respondents, not for the workspace's own screens.
- **The sign-in, onboarding and organization-level pages, which sit outside any one workspace.** They are shown before or above a workspace, so there is no workspace vocabulary to apply.
- **A few server error messages raised where the workspace's names are not available.** These messages are thrown by server actions or shared with the agent tools, and the code that raises them does not read the workspace's names. They are:
  - Opportunity not found, Solution not found, Solution opportunity mismatch and Solution squad mismatch (Roadmap, Feedback and Discovery actions)
  - Solution not found in opportunity, and This workspace has no active Solution scoring model (Discovery actions)
  - The parent Key Result rules when linking an Objective: not found, same objective, closed cycle, time horizon, circular hierarchy
  - Link errors shared with the agent tools: Opportunity, Solution, Objective and Key Result not found
  - The card sort message for proposing a new entry outside an Opportunity round, and This field is not an Opportunity field on the board
- **URLs (such as /okrs and /discovery), stored values, analytics event names and the internal component gallery.** These are identifiers or developer tooling, not product copy; renaming identifiers would break links and data.

Everything else in a workspace, including the canvas, the Discovery board, table and swimlane, every panel, decisions and reviews, search, measurements, squads and card sort, follows your model and your renames. The error message that appears when a composer cannot create an opportunity because a Key Result is outside the workspace uses your word for Key Result.

## Agents and the thinking model

`get_workspace_summary` and `get_workspace_by_slug` report the workspace's model and its display names, including any renames of all five entities, in a read-only `thinkingModel` field, so an agent can use the same words when it writes to you. Agents cannot change the model, and every tool name and field keeps the standard names.
