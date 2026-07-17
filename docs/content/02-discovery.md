---
title: "Discovery"
description: "Map customer opportunities and explore solutions using the OST framework"
icon: "Lightbulb"
order: 2
section: "Core Features"
---

# Discovery

The Discovery section is the heart of Compass. It's where you manage your **Opportunity Solution Tree** — mapping customer problems to potential solutions and tracking their progress through your discovery funnel.

![Discovery board](/screenshots/docs/discovery-board.png)

> 📸 Screenshot: run `pnpm docs:screenshots` with a `DOCS_SESSION_FILE` to capture this image.

## The Opportunity Board

Opportunities move through four columns on the kanban board:

- **EXPLORING** — Newly created opportunities that are being investigated. You've heard this problem from customers but haven't yet assessed its importance or frequency.
- **VALIDATING** — Opportunities that look promising and are being actively validated. You're gathering more customer evidence, running interviews, or analysing usage data.
- **PRIORITIZED** — Opportunities that have been validated and selected for investment. Your team is working on solutions.
- **ACTIVE** — The opportunity your team is actively building toward right now. Typically only one or two opportunities are ACTIVE at a time.

Drag cards between columns to update status. You can filter the board by squad using the filter bar at the top of the page.

## Creating Opportunities

Click **+ Add Opportunity** in any column. An opportunity needs:

- **Title** — A short customer-centric problem statement (e.g. "Users don't know when their trial is expiring")
- **Description** — Context from customer interviews, support tickets, or usage data
- **Squad** — Optional team assignment
- **Key Result links** — Connect the opportunity to the outcomes it addresses

Write opportunity titles from the customer's perspective, not from a solution or feature angle. "Users can't find their billing history" is better than "Add billing history page."

## Solutions

Open an opportunity by clicking its card, then click **+ Add Solution** in the detail panel. A solution is a concrete idea for addressing the opportunity. Each opportunity can have multiple competing solutions — this is intentional. The OST methodology encourages exploring multiple solution directions before committing.

Solutions have a title, description, squad assignment, and a list of assumptions.

## Assumptions

Assumptions are the riskiest beliefs that need to be true for a solution to succeed. Click **+ Add Assumption** on any solution to capture them. Each assumption can be linked to an Experiment for testing.

Examples of good assumptions:
- "Users will check their trial status at least once a week"
- "An email reminder 7 days before expiry will reduce churn by 15%"
- "Users prefer in-app notifications to email for billing alerts"

## Evidence

Every opportunity, solution, and assumption can carry linked **Evidence** — the concrete signals that back up why you believe it. This is what makes a claim on the tree traceable back to its source instead of just an opinion.

Each piece of evidence has:

- **Source type** — Interview, Feedback, Support Ticket, Experiment Result, or Analytics
- **Excerpt** — The actual quote, ticket text, or data point
- **Confidence** — High, Medium, or Low, reflecting how strongly this signal supports the claim
- **Source URL** *(optional)* — A link back to the original interview recording, ticket, or dashboard

### Adding evidence

Click **+ Add Evidence** from any opportunity, solution, or assumption to attach a new signal. Evidence attaches to exactly one node — if it's more broadly relevant, you can re-parent it later.

### Where evidence shows up

- **Rollup badges** — Opportunity cards show a "Backed by N signals from M sources" badge; solution cards show "Backed by N signals." These count only evidence attached directly to that opportunity or solution — evidence attached to a solution or assumption doesn't roll up into its parent opportunity's badge.
- **Evidence list** — Opportunity, solution, and assumption detail views show the full list of evidence attached directly to that node, each tagged with its source type and confidence.

Because evidence doesn't roll up the tree, attach it to the specific node it actually supports — evidence for a particular solution belongs on that solution, not on the parent opportunity.

## The OST Tree View

Switch from board view to **Tree view** using the toggle at the top right of the Discovery page. The Tree view renders your full Opportunity Solution Tree:

- Your active OKR outcome at the root
- Opportunities branching from the outcome
- Solutions hanging off each opportunity
- Assumptions attached to each solution

This view is most useful in team discussions and stakeholder reviews, where you need to show the full reasoning chain from outcome to experimental evidence.
