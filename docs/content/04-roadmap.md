---
title: "Roadmap"
description: "Plan and communicate what you're building across Now, Next, and Later horizons"
icon: "Map"
order: 4
section: "Core Features"
---

# Roadmap

The Roadmap is a three-horizon view of what your team is building. It stays intentionally lightweight by default — communicating direction and priority without forcing you to predict dates beyond the near term — but once an item's timing is known, adding a start and end date turns its placeholder bar on the Timeline view into a real, dated one.

![Roadmap](/screenshots/docs/roadmap.png)

> 📸 Screenshot: run `pnpm docs:screenshots` with a `DOCS_SESSION_FILE` to capture this image.

## The Three Horizons

- **Now** — Work that is currently in flight. Your team is actively building or shipping these items. Keep this column short and honest: if it's not genuinely in progress, it belongs in Next.
- **Next** — Committed work coming up after Now items ship. These items have been prioritised and are ready to start. They have enough detail and justification to begin when capacity opens.
- **Later** — Directional bets you're exploring but haven't committed to yet. Items here are placeholders for things that are likely important but whose timing and scope aren't settled.

## Creating Roadmap Items

Click **+ Add Item** in any horizon column. A roadmap item has:

- **Title** — What you're building
- **Description** — Why you're building it
- **Horizon** — Now / Next / Later
- **Linked Opportunity** — The customer problem this solves
- **Linked Solution** — The specific solution approach
- **Linked Key Result** — The outcome it contributes to
- **Linked Experiment** — The experiment that validated the approach
- **Squad** — Team assignment
- **Start date / End date** — Optional. Leave these blank for items whose timing isn't settled yet — the item still appears on the Timeline as a dashed placeholder bar you can drag to schedule; fill them in (here, via Edit, or by dragging the bar) once you know when the work will happen.

The linked metadata appears as small icon badges on each card, giving stakeholders a quick way to trace the evidence behind each item. Use a card's **Edit** menu action at any time to add or change its title, description, or dates.

## Timeline View

Toggle between **Board** and **Timeline** at the top of the Roadmap page. Timeline renders every roadmap item as a bar on a Gantt-style chart, colored by horizon, so you can see what's planned to run concurrently and spot scheduling conflicts. Items that don't have a start and end date yet still appear — as a dashed, outlined bar starting today — so you can drag or resize them directly to set real dates instead of hunting for the Edit dialog. A count above the chart calls out how many items are still on placeholder dates.

Drag a bar to shift its dates, or resize it from either edge to change its start or end date — changes save immediately. The Timeline view is linkable: `?view=timeline` in the URL takes you straight there, and the squad filter carries over from the Board.

## Not Yet on the Roadmap

Below the board (and the Timeline), Compass surfaces a **Not yet on the roadmap** panel — validated or in-delivery Solutions from Discovery, and Bug-type Feedback items, that don't have a roadmap item yet. These are the same items that already have a "Promote to roadmap" action on the Discovery solution card or the Feedback board; this panel is a second entry point that lets you schedule them without leaving the roadmap.

- **On the Board** — drag a card from the panel onto any horizon column to schedule it there, or use its **⋯** menu to add it directly to Now/Next/Later without dragging.
- **On the Timeline** — drag a card onto the chart area to open a small dialog for setting its horizon and start/end dates, since the Gantt chart has no way to infer a date purely from where you drop something. The panel's quick-add menu still works here too — it schedules the item without dates, which now shows up immediately on both the Board and the Timeline (as a dashed placeholder bar you can drag to set real dates).

Ideas (as opposed to Bugs) aren't included in this panel — they're expected to go through Opportunity → Solution discovery first, same as everywhere else in Compass.

## Drag to Reorder

Within each horizon, drag cards to reorder them. Order within a horizon communicates relative priority: items higher in the list are higher priority. This ordering is persisted and visible to all workspace members.

## Keeping the Roadmap Honest

A roadmap that isn't updated is worse than no roadmap — it creates false confidence. Compass is designed to make updates low-friction: drag to move between horizons, click to update details. The links to opportunities, KRs, and experiments mean the roadmap is always one click away from the evidence behind it.
