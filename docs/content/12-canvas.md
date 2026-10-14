---
title: "Canvas"
description: "Build your OKR, discovery, and roadmap tree onto a Canvas doc, then drag, group, and arrange it"
icon: "Waypoints"
order: 12
section: "Core Features"
---

# Canvas

Compass models a full discovery hierarchy — OKRs, Opportunities, Solutions, Assumptions, Experiments, and the Roadmap — but each layer normally lives on its own page. **Build tree** lays the whole connected graph out on a [Canvas doc](/help/06-docs#canvas-docs) in one click, with real edges between related cards, so you can trace how a Key Result led to an Opportunity, a Solution, and eventually a shipped Roadmap item.

The result is an ordinary Canvas doc. You can drag cards, resize them, group them, add notes and links, undo, and share it like any other page. (Earlier versions had a separate read-only Canvas screen; the old `/canvas` address now opens the Docs library.)

## Building a tree

1. Open a Canvas doc (create one with **New → New diagram** in the Docs library).
2. Click **Tree** ("Build tree from Compass…") in the toolbar.
3. Choose the scope:
   - **Whole workspace** draws every Objective with everything beneath it, plus any opportunities, solutions and roadmap items that are not under an Objective.
   - **From a specific item** draws one Objective, Key Result, Opportunity or Solution and everything beneath it. Search by title to pick it.
4. Click **Build**. The cards are laid out automatically and the view zooms to them.

Each Objective's cards are wrapped in a labelled **group**, so you can see the branches at a glance.

Building is safe to repeat:

- A Compass object already on the canvas is never duplicated, moved, or regrouped.
- An arrow you deleted does not come back when you build again; only arrows touching newly added cards are drawn.
- New content lands to the right of what is already there, never on top of it.
- A single build adds at most 400 cards. If the tree is larger, the top of the tree is added first and you are told it was truncated; build from a specific item to get the rest.
- The whole build is one undo step.

## What you'll see

Each entity is a live Compass card (status, score, progress and so on are read each time you open the canvas). Click a card to open the object.

| Entity | Connects to |
|---|---|
| Objective | → its Key Results |
| Key Result | → any Opportunity linked to it |
| Opportunity | → its Solutions |
| Solution | → its Assumptions |
| Assumption | → any Experiment testing it |
| Experiment | terminal in the tree |
| Roadmap item | terminal — always an arrow target, never a source |

## Edges

- An arrow always points from parent to child in the OST chain (Objective → Key Result → Opportunity → Solution → Assumption → Experiment).
- The Key Result → Opportunity edge comes from the opportunity's **Driving Key Result**, and the Opportunity → Solution edge from the solution's one parent opportunity. The other links are drawn as **colored secondary** arrows with the same direction (Objective → Opportunity, and Solution → Key Result). Which Objective → Opportunity links appear depends on the workspace's [thinking model](/help/27-thinking-models):
  - **Classic** draws only the links someone made on purpose (in the opportunity's Objectives box or through an agent). Links Compass created automatically from older Driving Key Results are not drawn, so a Classic canvas does not change just because those links now exist.
  - **Opportunity-first and Torres** draw every Objective → Opportunity link. A link that only repeats a Driving Key Result (the Objective already reaches the opportunity through Objective → Key Result → Opportunity) is skipped, so one relationship never has two lines.
  - Solution → Key Result links are always user-made, so every model draws them.
  Secondary arrows never affect the automatic layout.
- **Roadmap items** are the one place the graph isn't strictly tree-shaped — an item can be promoted from a Solution, an Experiment, an Opportunity, or a Key Result, and can carry more than one of those links at once. The most specific origin (Solution, if set; otherwise Experiment; otherwise Opportunity; otherwise Key Result) gets the primary edge. Any additional parent links render as secondary arrows.
- A Roadmap item with none of those links resolvable (for example, one promoted straight from customer feedback with no OST parent) has no incoming arrow — that's expected, not a bug.

## Scope of a build

A build includes every Objective from **every OKR cycle** in the workspace, including Objectives with no cycle (see [OKRs](/help/01-okrs)), and Opportunities, Solutions, Assumptions and Experiments regardless of status, so no Solution is left pointing at a missing Opportunity. Only Active Roadmap items are drawn.

Cards are a snapshot of structure: if the tree changes later (a new Solution, say), run **Build tree** again and only the new cards and their arrows are added. Removing something from Compass makes its card show as unavailable; delete it from the canvas yourself.
