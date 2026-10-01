---
title: "Thinking models"
description: "Choose how your workspace names and relates Objectives, Key Results, Opportunities and Solutions"
icon: "Lightbulb"
order: 27
section: "Core Features"
---

# Thinking models

A **thinking model** is a workspace setting that decides how Compass *names* and *presents* the same four things: Opportunities, Objectives, Key Results and Solutions. It changes words and a few screens. It never changes your data, so you can switch models at any time and nothing is migrated or deleted.

Only a workspace admin can change it: open **Settings**, find **Thinking model**, pick a model and select **Save**. An organization admin who is not a member of the workspace cannot change it.

Compass stores only the name of the model you pick (plus any renames of Objective and Key Result). A workspace that never chose one, or whose setting is blank, uses **Classic OKRs** forever, and Classic stays selectable at any time.

## The three models

| Model | What it is | Words | Extra screens |
|---|---|---|---|
| **Classic OKRs** (the default) | Compass as it has always worked. Every workspace that never chose a model uses it, and always will. | Objective, Key Result | None |
| **Opportunity-first OKRs** | Opportunities are the whole landscape of needs. You choose which ones to pursue by linking them to Objectives. | Same as Classic | A workspace tree that starts from a pool of opportunities, and the Objectives picker on each opportunity |
| **Torres opportunity solution tree** | An Objective is the *outcome* at the root of a tree. Key Results become that outcome's success metrics. | **Outcome** for Objective, **Success metric** for Key Result | A workspace tree rooted on outcomes, a flat list of all outcomes on the Outcomes page, and the Outcomes picker on each opportunity |

Under Torres the OKRs entry in the sidebar is called **Outcomes**, and forms, headings and chips on the OKR, Discovery, roadmap and task screens use the new words.

### What does not change

- Your Objectives, Key Results, Opportunities, Solutions, cycles and links are the same under every model.
- Agents and API tools always use the standard names (Objective, Key Result), whatever your workspace calls them.
- Some screens still use the standard names under every model: the canvas, the discovery board, the solution, assumption, experiment and feedback panels, error messages, the public portal and help. The note in the Settings section lists them.
- A Classic workspace sees no new screens and no new controls at all.

## Renaming Objective and Key Result

On the same Settings section you can give **Objective** and **Key Result** a workspace-specific name (singular, and optionally plural; if you leave the plural empty an "s" is added, so give one when that would be wrong). Letters, numbers, spaces and `' & / -` only, up to the length shown on the form.

Only those two can be renamed. Opportunity, Solution and Cycle names are fixed for now, and you cannot define your own hierarchy or new kinds of link.

## The workspace tree

Under Opportunity-first and Torres, **Discovery** has a tree button, named **Outcome tree** under Torres and **Objective tree** under Opportunity-first. It opens a tree for the whole workspace. Classic workspaces do not have this page.

**Torres (outcome-rooted):**

- Each outcome is a card. Its success metrics sit in a scrollable strip across the top: they are measures, not branches.
- Under the outcome are the opportunities you linked to it, and under each opportunity its solutions.
- A solution shows a chip for each success metric it targets. If that metric belongs to an outcome the opportunity is *not* linked to, the chip also names that outcome, so a cross-outcome aim is visible rather than hidden.
- An opportunity linked to several outcomes shows its full branch once, under the first of them. Under the others you see a short **Also under …** line with a **Show** button that expands the same branch. Counts at the top of each card count each opportunity and solution only once.
- Opportunities linked to no outcome are collected at the bottom under **Opportunities not linked to outcomes**. Archived opportunities are left out.
- A small chip shows the cycle the outcome belongs to. An outcome that supports a key result of another outcome shows a **Supports …** chip; it is not nested.

**Opportunity-first (pool first):** the pool of unlinked opportunities comes first, then each Objective with its Key Results; each Key Result lists the solutions aimed at it, and solutions that target none of its Key Results are listed separately.

If an opportunity has no link but its **Driving Key Result** is set, it is placed under that Key Result's Objective, so older data does not fall into the pool.

## The Outcomes list (Torres)

On the **Outcomes** page a flat list of every outcome appears above the cycles. Each row shows the status, the number of linked opportunities, and a chip for its cycle. You do not need to open a cycle first to see them. Every outcome still belongs to a cycle, and you create one inside a cycle.

## Linking an opportunity to Outcomes or Objectives

On an opportunity's page or panel, under Opportunity-first and Torres, an **Outcomes** (or **Objectives**) box lists what the opportunity is linked to. Select **Change** (or **Link outcomes** when there are none), then tick or untick items. Each tick saves immediately. An opportunity can serve several.

If a link exists only because the opportunity's **Driving Key Result** sits under that Objective, unticking it explains that it is still linked through the Key Result; change the Key Result to remove it.

You need to be a member of the workspace. Linking is the same data whatever the model, so agents can read and change the same links with the link tools described in the [MCP API](/help/09-mcp-api#typed-links) page.

## Linking a solution to Key Results

A solution can also be linked to the Key Results (success metrics) it is meant to move; it still belongs to exactly one opportunity. The workspace tree shows these links, as described above. Today they are created and removed by agents, with `link_solution_to_key_result` and `unlink_solution_from_key_result`; the tree and `list_links` are where you read them.

## Agents and the thinking model

`get_workspace_summary` and `get_workspace_by_slug` report the workspace's model and its display names in a read-only `thinkingModel` field, so an agent can use the same words when it writes to you. Agents cannot change the model, and every tool name and field keeps the standard names.
