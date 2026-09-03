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

Tracked decisions are informational. Approve, Request changes, and Reject
record what a person decided; they do not automatically modify the linked
Opportunity, Solution, Roadmap Item, Doc, Experiment, or Feedback item.

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
