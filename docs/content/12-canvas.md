---
title: "Canvas"
description: "Pan and zoom across your full OKR, discovery, and roadmap graph on one infinite canvas"
icon: "Waypoints"
order: 12
section: "Core Features"
---

# Canvas

Compass models a full discovery hierarchy — OKRs, Opportunities, Solutions, Assumptions, Experiments, and the Roadmap — but each layer normally lives on its own page. Canvas gives you a single Figma/Miro-style pan-and-zoom view of the whole connected graph, with real edges between related cards, so you can trace how a Key Result led to an Opportunity, a Solution, and eventually a shipped Roadmap item without jumping between pages and mentally re-linking IDs.

## What you'll see

Every entity renders as its own connected card, laid out automatically:

| Entity | Color / icon | Connects to |
|---|---|---|
| Objective | Neutral card, status badge, aggregate progress bar | → its Key Results |
| Key Result | Indigo, outcome (trending-up) icon | → any Opportunity linked to it |
| Opportunity | Violet, lightbulb icon | → its Solutions |
| Solution | Blue, layers icon | → its Assumptions |
| Assumption | Amber, risk-colored warning icon | → any Experiment testing it |
| Experiment | Emerald, flask icon | shows a conclusion badge (Proceed / Kill / Iterate) once one is logged |
| Roadmap item | Neutral card, horizon-colored pill, red bug badge if it originated from a bug report | terminal — always an edge target, never a source |

## Edges

- A **solid arrow** always points from parent to child in the OST chain (Objective → Key Result → Opportunity → Solution → Assumption → Experiment).
- **Roadmap items** are the one place the graph isn't strictly tree-shaped — an item can be promoted from a Solution, an Experiment, an Opportunity, or a Key Result, and can carry more than one of those links at once. The most specific origin (Solution, if set; otherwise Experiment; otherwise Opportunity; otherwise Key Result) gets the solid primary edge. Any additional parent links render as **dashed** secondary edges, so you can still see every connection without the graph reading as a confusing multi-parent tangle.
- A Roadmap item with none of those links resolvable (for example, one promoted straight from customer feedback with no OST parent) renders as an **orphan node** with no incoming edge — that's expected, not a bug.

## Navigating

- **Pan**: click and drag anywhere on the canvas background.
- **Zoom**: use the zoom controls in the bottom-left corner, your trackpad/mouse wheel, or pinch-to-zoom.
- Canvas automatically fits the whole graph into view when the page loads.

## Scope of this release

Canvas renders every Objective from **every OKR cycle** in the workspace, not just the active one — this is deliberate, so the view stays useful for tracing history across a full portfolio, not just the current quarter. Opportunities, Solutions, Assumptions, and Experiments are rendered without a status filter for the same reason: excluding, say, an Archived Opportunity would leave any Solution still pointing at it with a dangling edge. Roadmap items are the one exception — only Active items render, since a Roadmap item is always an edge target and filtering it can't orphan anything downstream.

This is one eager, un-tiered render of the full graph — every entity, every time. Not yet included:

- **Semantic zoom tiers** — showing only OKRs when zoomed out and progressively revealing Opportunities/Solutions/Assumptions/Experiments as you zoom in, for workspaces where an eager render gets crowded.
- **Lazy per-Key-Result loading** — fetching a KR's downstream chain on demand instead of the whole workspace graph up front.
- **Dragging a card to manually pin its position** (positions are computed automatically every time).
- **Animated focus-navigation** or **URL deep-linking** to a specific node.
- A dedicated mobile layout — Canvas is reachable on mobile by direct URL, but an infinite pan/zoom surface is a poor fit for small screens, so it isn't in the mobile navigation.

These are on the roadmap for future phases.
