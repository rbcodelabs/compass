---
title: "Roadmap"
description: "Plan and communicate what you're building across Now, Next, and Later horizons"
icon: "Map"
order: 4
section: "Core Features"
---

# Roadmap

The Roadmap is a three-horizon view of what your team is building. Unlike a Gantt chart or a backlog, Compass roadmaps are intentionally lightweight — they communicate direction and priority without pretending to predict dates beyond the near term.

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

The linked metadata appears as small icon badges on each card, giving stakeholders a quick way to trace the evidence behind each item.

## Drag to Reorder

Within each horizon, drag cards to reorder them. Order within a horizon communicates relative priority: items higher in the list are higher priority. This ordering is persisted and visible to all workspace members.

## Keeping the Roadmap Honest

A roadmap that isn't updated is worse than no roadmap — it creates false confidence. Compass is designed to make updates low-friction: drag to move between horizons, click to update details. The links to opportunities, KRs, and experiments mean the roadmap is always one click away from the evidence behind it.
