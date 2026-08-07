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

## Linking annual and quarterly OKRs

Objectives in a shorter cycle can support a Key Result in a longer cycle. This creates a measurable hierarchy without duplicating annual goals inside every quarter:

```text
Annual Objective
└── Annual Key Result
    ├── Q1 Objective
    │   └── Quarterly Key Results
    └── Q2 Objective
        └── Quarterly Key Results
```

You can create the relationship from either side:

- **From the quarterly Objective:** open its **Alignment** section and choose the higher-level KR under **Supports a higher-level Key Result**.
- **From the annual Key Result:** select **Link supporting objective** and choose an eligible quarterly Objective. Use the unlink control beside a supporting Objective to remove the relationship.

Compass offers parent Key Results only from Draft or Active longer-horizon cycles whose dates fully contain the shorter cycle. On the annual side, it offers only unlinked Objectives from strictly shorter, fully contained cycles. For example, a January 1–December 31 annual cycle can be the parent of a January 1–March 31 quarterly cycle. Compass does not create cycles or Objectives automatically.

The quarterly Objective shows its selected parent KR. The annual KR lists every supporting quarterly Objective, including its cycle, squad, and current progress. Existing relationships remain visible after a cycle closes, but closed cycles cannot receive new supporting Objectives.

Compass does not automatically calculate annual KR progress from quarterly KR percentages. Annual and quarterly KRs may use different measures, targets, or weighting, so each KR retains its own check-ins and current value.

## Check-ins

Click the **+ Check-in** button on any Key Result to record the current value. Check-ins create a timestamped history so you can track progress over time. The progress bar on each KR reflects the latest check-in value relative to the target.

## Linking OKRs to Discovery

Key Results are the bridge between outcomes and work. When you create an Opportunity on the Discovery board, you can link it to one or more Key Results. Roadmap items can also be linked to KRs, so you always have a clear line from "what we decided to build" back to "why we decided to build it."
