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
- Canvas opens at the **Portfolio** view — a tidy grid of all your Objectives, fit to the screen. (A workspace that has discovery or roadmap work but hasn't set any Objectives yet opens on the full graph instead, since there's no Portfolio to show.)

## Zoom tiers

Canvas shows progressively more detail as you zoom in, so a large workspace doesn't dump everything on screen at once. A small badge near the bottom-left zoom controls always shows which tier you're currently at:

| Tier | Badge | Shows |
|---|---|---|
| **T0** | "Portfolio" | Every Objective, arranged in a compact grid — title, status badge, aggregate progress bar. This is the landing view. Key Results and everything downstream are hidden. |
| **T1** | "Cycle" | Objective + Key Result cards, and the edges between them. Opportunities, Solutions, Assumptions, Experiments, and Roadmap items stay hidden. |
| **T2** | "Detail" | The full graph — every entity and edge, same as described above. |

**Why the Portfolio grid is its own layout.** In the detailed graph (T1/T2), each Objective is positioned to make room for its whole discovery tree beneath it, so Objectives naturally spread far apart. That's right for exploring one Objective's subtree, but it means "zoom all the way out to see everything" would leave your Objectives scattered across a huge canvas as unreadable specks. So the Portfolio tier lays the Objectives out on their own — a dense, readable grid — independent of how deep the tree beneath each one runs.

**Crossing between Portfolio and detail animates.** Zoom in from the Portfolio grid and Canvas smoothly slides the Objectives from the grid into their detailed-graph positions, centering on whichever Objective you were looking at so you dive into *that* Objective's neighborhood. Zoom back out and they glide back into the grid. Moving between the two detailed tiers (Cycle ↔ Detail) just reveals or hides cards in place — nothing moves. Either way nothing is re-fetched, so switching is instant and non-destructive.

Not yet built: click-to-focus animated navigation to jump straight to a specific node by clicking it, and URL deep-linking (e.g. a link that opens Canvas already zoomed into one Key Result). Both are on the roadmap for a future increment, along with T0 squad-clustering for very large portfolios.

## Scope of this release

Canvas renders every Objective from **every OKR cycle** in the workspace, not just the active one — this is deliberate, so the view stays useful for tracing history across a full portfolio, not just the current quarter. Opportunities, Solutions, Assumptions, and Experiments are rendered without a status filter for the same reason: excluding, say, an Archived Opportunity would leave any Solution still pointing at it with a dangling edge. Roadmap items are the one exception — only Active items render, since a Roadmap item is always an edge target and filtering it can't orphan anything downstream.

Not yet included:

- **Lazy per-Key-Result loading** — fetching a KR's downstream chain on demand instead of the whole workspace graph up front.
- **Dragging a card to manually pin its position** (positions are computed automatically every time).
- **Click-to-focus navigation** (clicking a card to fly to it) or **URL deep-linking** to a specific node. Zooming already animates you into the Objective nearest the center of your view, but there's no way yet to target a specific one by clicking or by link.
- **T0 squad-clustering** — grouping/collapsing Objectives by squad within the Portfolio grid.
- A dedicated mobile layout — Canvas is reachable on mobile by direct URL, but an infinite pan/zoom surface is a poor fit for small screens, so it isn't in the mobile navigation.

These are on the roadmap for future phases.
