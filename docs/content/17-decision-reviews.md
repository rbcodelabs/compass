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

## Configure NOW eligibility

NOW preparation fails closed until the deployment supplies
`NOW_COMMITMENT_POLICY_JSON`, or `NOW_COMMITMENT_POLICY_FILE` pointing to a
generated JSON file. The file form is useful for local/ephemeral environments
whose native decision and receipt IDs are created during setup; application
source must never contain mutable authority IDs. The value is a versioned JSON document keyed by
workspace UUID. Each workspace entry names the immutable portfolio policy,
authoritative capacity plan, applied investment decisions keyed by Solution
UUID, and any explicit displacement required when capacity is full:

```json
{
  "version": 1,
  "workspaces": {
    "<workspace-uuid>": {
      "portfolioPolicyId": "portfolio-policy:2026-h2",
      "capacity": {
        "planId": "<capacity-plan-uuid>",
        "planFingerprint": "<64-character-sha256>",
        "unit": "FOCUS_SLOT",
        "availableUnits": 3,
        "requestedUnits": 1,
        "unitsPerNowItem": 1,
        "nowLimit": 3
      },
      "investmentDecisions": {
        "<solution-uuid>": {
          "authorityProvider": "COMPASS_NATIVE",
          "authorityRecordId": "<decision-record-id>",
          "authorityChecksum": "<64-character-sha256>",
          "decisionOutcome": "APPROVE_BUILDING",
          "applicationStatus": "APPLIED",
          "applicationReceiptId": "<receipt-id>"
        }
      },
      "displacementByRoadmapItemId": {
        "<candidate-roadmap-item-uuid>": {
          "itemId": "<existing-now-item-uuid>",
          "destination": "NEXT"
        }
      }
    }
  }
}
```

Compass's v1 policy is closed: the workspace has exactly three `FOCUS_SLOT`
units, every NOW item requests and consumes one slot, `nowLimit` is three, and
an explicitly named displaced item returns to `NEXT`. Other units, weights,
limits, or displacement destinations fail configuration validation.

Capacity plans are always created in `DRAFT`; a plain insert cannot authorize
NOW admission. Before use, run the bounded reconciliation/activation operation,
which reserves every existing NOW item, rejects any NOW/reservation drift,
checks both the item limit and summed units, and uses optimistic concurrency to
transition the plan to `ACTIVE`. The resulting active authoritative plan must
match the workspace policy, fingerprint, unit, available units, and NOW limit.
Displacement is optional while capacity remains, but when supplied its
destination must be `NEXT`.

## Authorize a release

An agent may call `request_release_authorization` with an exact GitHub PR scope
and covered Task IDs. A human administrator reviews the immutable head SHA,
policy, environment, and Task set in Compass. Approval is recorded in the same
decision ledger as NOW commitments.

Applying that recorded decision only creates an idempotent durable dispatch
receipt. This release slice is intentionally queue-only: it does not merge,
deploy, or call external release automation. Authoritative GitHub/check/policy
validation is not configured by default, so application fails closed with
`PR_NOT_READY`. A future dispatch worker is required to revalidate the same
canonical snapshot again when claiming the dispatch, before any external side
effect.
