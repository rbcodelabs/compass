---
title: "Scoring Models"
description: "Rank opportunities objectively with org-wide scoring templates like RICE"
icon: "Calculator"
order: 11
section: "Configuration"
---

# Scoring Models

Scoring Models let you rank Opportunities objectively instead of ordering them by gut feel. An organization admin defines named templates — RICE, ICE, or any custom formula your team prefers — and each workspace picks one template to use. Every workspace using the same template scores opportunities on a comparable 0–100 scale, so you can compare priorities across teams, not just within one.

## How It Works

Scoring in Compass has three layers:

1. **Scoring Models** (org-level) — Named templates, authored by organization admins, each with a set of metrics (e.g. Reach, Impact, Confidence, Effort) and a formula type.
2. **Active Model** (workspace-level) — Each workspace selects one scoring model to use. Any member can then score opportunities against it.
3. **Opportunity Scores** — Each opportunity gets its own raw values, a computed raw score, and a normalized 0–100 score.

## Creating a Scoring Model

Organization admins manage scoring models in **Org Settings → Scoring Models** (linked from the sidebar for admins/owners). When creating a model, specify:

- **Name** — e.g. "RICE", "ICE", "Effort vs. Impact"
- **Description** — When and why to use this model
- **Formula Type**:
  - **Weighted Sum** — Metrics are summed (POSITIVE direction) or subtracted (NEGATIVE direction), each multiplied by its weight.
  - **Multiplicative** — True RICE-style: positive-direction metrics are multiplied together in the numerator, negative-direction metrics (like Effort) are multiplied together in the denominator. Every metric's minimum value must be greater than 0 for this formula type, to avoid dividing by zero.
- **Metrics** — Each metric has a key (stable, used internally), a label, a min/max range, a weight, and a direction (POSITIVE increases the score, NEGATIVE decreases it).

## Editing a Scoring Model

You can always edit a model's name and description without any side effects. Editing the metrics (adding, removing, or reweighting them) or changing the formula type bumps the model's **version** — existing opportunity scores are **not** retroactively recalculated. Each score stores a frozen snapshot of the formula that produced it, so historical scores stay accurate even after the template changes. The Opportunity Scoring tab shows a banner when a score was computed under an earlier version, prompting a re-score.

A scoring model is never permanently deleted — instead it can be **archived**, which hides it from the workspace picker for new selections while leaving it valid for workspaces already using it and for historical scores.

## Activating a Model for Your Workspace

Workspace admins choose the active scoring model in **Workspace Settings → Scoring**. The dropdown lists every `ACTIVE` model defined in the organization. Selecting **None** disables scoring for the workspace — the Scoring tab disappears from opportunity pages until a model is selected again.

## Scoring an Opportunity

Once a workspace has an active scoring model, every opportunity detail page shows a **Scoring** tab. Any workspace member can enter raw values for each metric (bounded to the metric's configured min/max) and see a live preview of the raw and normalized score before saving. Saving stores the score along with the model version and formula snapshot used to compute it.

## Why Normalized Scores?

Raw scores from different formulas and scales aren't directly comparable — a RICE score of 40 means something different from an ICE score of 8. Every Opportunity Score also stores a **normalized score from 0 to 100**, computed from the theoretical best/worst possible outcome for that specific model. This is what makes it possible to compare priorities across workspaces that use different scoring templates, and is the basis for any future cross-workspace "top opportunities" view.
