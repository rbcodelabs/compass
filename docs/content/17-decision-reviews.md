---
title: "Decision Reviews"
description: "Use immutable human review packets to authorize NOW commitments"
icon: "CircleCheckBig"
order: 17
section: "Delivery"
---

# Decision Reviews

Compass protects consequential delivery transitions with a shared, immutable
decision ledger. The first supported gate is the commitment to move a Roadmap
Item into **NOW**.

## Commit an item to NOW

1. Create or move the Roadmap Item into **NEXT** or **LATER**.
2. Open the item detail panel and choose **Request NOW commitment**.
3. Inspect the stable review page. It records the item, its linked Solution and
   Opportunity, owning Squad, policy version, and an exact content fingerprint.
4. A signed-in workspace administrator or organization administrator chooses
   **Commit to NOW**, **Keep out of NOW**, or **Request changes**.

An approval records the human actor and applies the NOW transition with an
idempotent receipt. Repeating the application does not repeat the effect.

## When the underlying item changes

The decision applies only to the exact packet the reviewer saw. If fingerprinted
inputs change, Compass supersedes the old revision and requires a new review.
Agents and service credentials can prepare packets and apply a decision that a
human already recorded, but they cannot take the decision themselves.

The same ledger contract is reserved for release authorization. ReleaseRun will
use this shared record and receipt model rather than introducing a separate
release-decision system.
