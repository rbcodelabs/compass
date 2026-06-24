---
title: "OKRs"
description: "Set outcomes with Objectives and Key Results to drive focused discovery"
icon: "TrendingUp"
order: 1
section: "Core Features"
---

# OKRs

OKRs (Objectives and Key Results) are the starting point for discovery in Compass. Before you can connect opportunities and solutions to outcomes, you need at least one active OKR cycle with a defined Objective and Key Results.

![OKRs page](/screenshots/docs/okrs.png)

> 📸 Screenshot: run `pnpm docs:screenshots` with a `DOCS_SESSION_FILE` to capture this image.

## OKR Cycles

Every workspace has one or more **OKR cycles** — time-boxed periods (typically a quarter) during which you track progress toward your objectives. A cycle has a name (e.g. "Q3 2025") and optional start and end dates. You can have multiple cycles open at once, which is useful when teams operate on different cadences.

To create a new cycle, click **+ New Cycle** at the top of the OKRs page.

## Objectives

An Objective is a qualitative, inspiring statement of what you want to achieve. It should be directional but not measurable — the Key Results handle measurement. Each Objective belongs to a cycle.

Click **+ Add Objective** inside a cycle to create one. Objectives can be assigned to a squad and tagged with custom fields.

## Key Results

Key Results are the measurable outcomes that tell you whether you've hit your Objective. Each KR has:

- **Name** — A short description (e.g. "Increase weekly active users")
- **Target value** — The number you're aiming for (e.g. `10000`)
- **Unit** — The unit of measurement (e.g. `users`, `%`, `$`, `ms`)
- **Current value** — Updated via check-ins

A well-formed Key Result is binary-testable at the end of the cycle: either you hit the target or you didn't.

## Check-ins

Click the **+ Check-in** button on any Key Result to record the current value. Check-ins create a timestamped history so you can track progress over time. The progress bar on each KR reflects the latest check-in value relative to the target.

## Linking OKRs to Discovery

Key Results are the bridge between outcomes and work. When you create an Opportunity on the Discovery board, you can link it to one or more Key Results. Roadmap items can also be linked to KRs, so you always have a clear line from "what we decided to build" back to "why we decided to build it."
