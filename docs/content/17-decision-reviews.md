---
title: "Decisions"
description: "Track clear human decisions without changing linked work"
icon: "CircleCheckBig"
order: 17
section: "Delivery"
---

# Decisions

Compass provides a simple shared record of decisions. A workspace member can
ask a question, provide context, and link it to relevant product work. A
workspace or organization administrator records the outcome and rationale.
Decision context and rationale support Markdown, so longer reasoning can use paragraphs, headings, lists, links, code, and tables.

The review page separates that narrative context from its product objects. The
primary linked item and any supporting sources appear as compact titled rows
with their object type and captured version date. Supported product objects open
in their detail panel, Docs open in the Docs workspace, and immutable Evidence
snapshots remain readable even when they do not have a dedicated destination.
Raw object IDs are not shown in the review UI.

Tracked decisions are informational. Approve, Request changes, and Reject
record what a person decided; they do not automatically modify the linked
Opportunity, Solution, Roadmap Item, Doc, Experiment, or Feedback item.

Agents can attach up to 12 supporting sources when requesting a decision. Compass
validates that every source belongs to the same workspace and snapshots its
title and version date into the immutable review packet. Renaming or removing a
source later does not erase what the reviewer originally saw.

## Roadmap behavior

Authorized roadmap actions work directly in every ordinary horizon, including
NOW. Moving an item to or from NOW does not require a policy, capacity plan, or
special approval and does not emit shadow-evaluation telemetry.

## Release authorization

Release authorization is independent from roadmap decision tracking. Its
existing immutable review and durable dispatch workflow remains available for
teams that use it.

## Legacy history

Reviews previously created for NOW commitments or native policy activation are
kept as read-only **Legacy system decision** records. Compass retains their
database rows, evidence, and migrations for audit history, but no longer lets
users decide, activate, or apply them. No operational configuration is required
for this dormant historical data.
