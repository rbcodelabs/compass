---
title: "Canvas"
description: "Pan and zoom across every Objective and Key Result on one infinite canvas"
icon: "Waypoints"
order: 12
section: "Core Features"
---

# Canvas

Compass models a full discovery hierarchy — OKRs, Opportunities, Solutions, and the Roadmap — but each layer normally lives on its own page. Canvas gives you a single Figma/Miro-style pan-and-zoom view to explore your portfolio without jumping between pages and mentally re-linking IDs.

**Phase 1** (this release) renders the Objective / Key Result tier only: every Objective across every OKR cycle in the workspace, laid out automatically, with each Objective's Key Results shown inline in its card.

## What you'll see

Each card on the canvas represents one Objective:

- Its title and squad (shown as a colored dot, if it belongs to one)
- Its status badge (On track, At risk, Off track, Complete)
- An overall progress bar, averaged across its Key Results
- Its Key Results, each with its own progress bar and current/target values

## Navigating

- **Pan**: click and drag anywhere on the canvas background.
- **Zoom**: use the zoom controls in the bottom-left corner, your trackpad/mouse wheel, or pinch-to-zoom.
- Canvas automatically fits every Objective into view when the page loads.

## Scope of this release

Canvas shows Objectives from **every OKR cycle**, not just the active one — this is deliberate, so the view stays useful for tracing history across a full portfolio, not just the current quarter.

Not yet included in this release:

- Opportunities, Solutions, Assumptions, Experiments, or Roadmap items on the canvas
- Dragging a card to manually pin its position (positions are computed automatically every time)
- Drilling into a single Key Result's downstream chain
- A dedicated mobile layout — Canvas is reachable on mobile by direct URL, but an infinite pan/zoom surface is a poor fit for small screens, so it isn't in the mobile navigation.

These are on the roadmap for future phases.
