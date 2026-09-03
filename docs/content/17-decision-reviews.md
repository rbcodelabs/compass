---
title: "Decisions"
description: "Request, review, and revisit product decisions in one shared history"
icon: "CircleCheckBig"
order: 17
section: "Delivery"
---

# Decisions

Open **Decisions** from a workspace to see what needs a call and what the team
already decided. Any workspace member can choose **New decision**, ask a clear
question, add context, and link it to the workspace or an Opportunity, Solution,
Roadmap Item, Doc, Experiment, or Feedback item. The same **Request decision**
shortcut appears on those item views.

Workspace and organization admins choose **Approve**, **Request changes**, or
**Reject**. A rationale is required for changes or rejection and optional for an
approval. These decisions are tracking-only: choosing an outcome records the
call and never changes the linked item. If changes are requested, use **Create
revised request** to carry the question and context into a new immutable cycle.

Use the **Pending** and **Decided** tabs to search or filter by linked item type,
outcome, reviewer, or decision date. Older automated authorization records stay
readable and are labeled **Legacy system decision**.

Agents can use `request_decision`, `list_decisions`, and `get_decision` for the
same tracking workflow. Service credentials may request and read decisions, but
only an authenticated human admin can choose an outcome.

## Legacy delivery reviews

Compass protects consequential delivery transitions with a shared, immutable
decision ledger. The first supported gate is the commitment to move a Roadmap
Item into **NOW**.

## Authorize Building investment

Before a Roadmap Item can enter NOW, its linked Solution needs an applied
Building-investment approval. Open the Solution panel and choose **Request
Building investment review**. Compass publishes an immutable packet containing
the exact Solution and Opportunity evidence. A signed-in workspace or
organization administrator chooses **Approve Building investment**, **Do not
invest**, or **Request changes**. Agents may prepare packets and apply recorded
approvals, but cannot make decisions.

Approval creates one idempotent `AUTHORIZE_BUILDING_INVESTMENT` receipt for the
exact Solution. Rejection and change requests create no authorization. To
reconsider those outcomes, call `reconsider_building_investment` with the
terminal decision ID and a reason. Approved investments cannot be silently
reopened; they require an explicit revocation workflow.

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

For Compass-native authority, `inspect_native_now_policy` derives policy inputs
only from the active workspace capacity plan and current, applied native
investment decisions. Generation fails closed on any workspace, revision,
option, receipt, subject, fingerprint, or capacity mismatch. The generator
also excludes any authority covered by an applied immutable
`BUILDING_INVESTMENT_REVOCATION`; the original approval and revocation remain
in the ledger for audit. A new authorization cycle is possible only after that
exact authority has a valid applied revocation. The generator signs both a
content-addressed artifact and its active selector with Ed25519.
Runtime verification requires the matching public key in
`NOW_DECISION_PUBLIC_KEYS_JSON`, an unexpired artifact, valid artifact and
selector signatures, the exact artifact hash, and a closed selector mode.

`NOW_DECISION_GATE_MODE` is the deployment ceiling and defaults to `off`.
`off` retains the legacy NOW transition and does not read native policy,
decision-gate, capacity, or shadow-audit tables. `shadow` verifies the signed
policy and performs the same read-only preflight, but never creates a review,
decision, application, reservation, or `NATIVE_GATED` provenance; the legacy
transition proceeds and Compass writes only a sanitized `WOULD_ALLOW` or
`WOULD_BLOCK` evaluation. A telemetry-write failure does not block that legacy
transition, but health reports incomplete shadow evidence. `enforce` requires
the native review and application path. The effective mode is always the less
permissive of the deployment ceiling and signed selector, so configuration can
downgrade but cannot elevate signed authority. Shadow evaluations contain no
raw policy or user content and must be retained for at least 180 days.

The private signing key is never application configuration. The complete signed
bundle belongs under `config/generated/decision-gates/<workspace-id>/`; the
atomically replaced, compare-and-swap pointer belongs at
`config/generated/decision-gates/<workspace-id>/active.json`. Runtime configuration points to
the immutable bundle, not the mutable pointer. Committing or activating these
files remains a separately reviewed rollout action.

After the exact activation review is approved and its receipt is applied, a
trusted local operator generates the files with `pnpm policy:generate-native`.
Supply the private Ed25519 PEM only through `NOW_DECISION_SIGNING_KEY_FILE`; the
file must be a regular `0600` file and is never logged, accepted on the command
line, copied into output, or sent to Vercel. The non-secret
`NOW_DECISION_SIGNING_KEY_ID` must exactly match `--signing-key-id`. The signer
derives routing from the closed manifest in `NOW_DECISION_ROUTING_MANIFEST_FILE`
(or the equivalent JSON environment value); a supplied routing fingerprint is
only a mismatch assertion and never routing authority. Required options are
`--workspace-id`, `--activation-decision-id`, `--mode`,
`--generated-at`, `--signing-key-id`, `--output-dir`, and
`--expected-active-artifact-id` and `--expected-active-selector-digest` (`none`
for both on the first activation).
`--valid-until` is optional and defaults to 14 days after generation.
Generation refuses invalid inputs and non-identical output collisions; an exact
rerun is idempotent. Selectors are workspace-bound and protected by an
exclusive lock, no-follow reads, inode revalidation, fsync, and compare-and-swap.
Policy validity defaults operationally to 14 days and may never exceed 30 days.
NOW review/application stores the exact artifact, activation, selector, signing
key, routing, and capacity provenance in immutable evidence records. Production
receives public verification keys only.

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
