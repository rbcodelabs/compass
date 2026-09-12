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

Discussion comments are deliberately different: they capture questions and working conversation on an item's detail panel, but never count as a decision or authorization. When a choice needs an accountable outcome and rationale, create a tracked Decision instead of relying on a comment thread.

Once a tracked Decision is approved, **Send to agent** appears in its recorded-decision banner and opens the in-app agent on that Decision — see [Send to agent](/help/20-send-to-agent). It is offered only for approved tracked Decisions, not for Request changes, Reject, release authorization, or legacy system records.

Agents can attach up to 12 supporting sources when requesting a decision. Compass
validates that every source belongs to the same workspace and snapshots its
title and version date into the immutable review packet. Renaming or removing a
source later does not erase what the reviewer originally saw.

## Supporting Artifacts

Wireframes and prototypes can be linked directly in **Linked to**, beneath the original subject. Workspace members select an active same-workspace Artifact with **Artifact to link** and choose **Link**. Open its title to view the current preview; **Unlink** removes only the relationship. Artifact detail shows reciprocal **Linked decisions** and also supports unlinking. A URL pasted into a discussion does not create this structured relationship.

Artifact rows show their current revision and archived status. They are **live supporting material, not frozen approval evidence**: they are separate from the captured **Sources** and never modify the immutable packet, fingerprint, Decision history, or outcome. Link changes work on both pending and decided requests and remain across request revisions. Existing archived links remain visible and removable, while newly linking archived Artifacts is disabled. Organization administrators who can read a Decision without workspace membership can see supporting rows but cannot edit Artifact relationships.

Agents use `link_artifact_to_decision` and `unlink_artifact_from_decision`. Both Decision MCP getters include live `artifacts`, and `get_artifact` includes `decisions`. Legacy system review requests do not support these links.

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
