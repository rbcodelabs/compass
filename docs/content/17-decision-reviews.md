---
title: "Decisions"
description: "Track clear human decisions without changing linked work"
icon: "CircleCheckBig"
order: 17
section: "Delivery"
---

# Decisions

Compass provides a shared record of product decisions. A workspace member or agent can ask a question, provide context, and link it to relevant product work. A workspace or organization administrator records the outcome and rationale. Decision context and rationale support Markdown, so longer reasoning can use paragraphs, headings, lists, links, code, and tables.

## Inbox Triage, Slide-Over Drawer, and Agent Chat Cards

Decision reviews appear across three coordinated surfaces:

1. **Inbox Triage (`/reviews/[id]`)** — Built for rapid review queues. A top triage bar displays the `DEC-n` identifier, semantic status badge (**Awaiting review**, **Approved**, **Changes requested**, **Rejected**), and a pending queue stepper (**1 of N pending** with **Previous** / **Next** controls) so admins can work straight through open requests. Above the fold, the **Triage Hero Card** surfaces the primary linked item, requester, decision question, and the interactive ballot (or semantic recorded-decision banner). Below the ballot, tabbed evidence panels organize **Context**, **Sources & Artifacts**, and **History** (when multiple revisions exist) without pushing the ballot off screen.
2. **Slide-Over Decision Drawer (`?detail=review:<id>`)** — Opens alongside boards, roadmaps, and chats so you can read the brief and record a decision without leaving your current page.
3. **Inline Agent Chat Quick Card** — Whenever an agent calls `request_decision` during a chat turn, Compass renders a live decision card directly in the conversation (both on `/agent` and in the right-hand Agent Rail). Workspace admins can approve a binary request or confirm an answer option inline in chat, or choose **Read brief & decide** (or **Answer in drawer** for multi-question requests) to open the slide-over Decision drawer for full Markdown context, rationale, or pushback.

Tracked decisions are informational. Approve, Request changes, and Reject record what a person decided; they do not automatically modify the linked Opportunity, Solution, Roadmap Item, Doc, Experiment, or Feedback item.

Discussion comments are deliberately different: they capture questions and working conversation on an item's detail panel, but never count as a decision or authorization. When a choice needs an accountable outcome and rationale, create a tracked Decision instead of relying on a comment thread.

Once a tracked Decision is approved, **Send to agent** appears in its recorded-decision banner and opens the in-app agent on that Decision — see [Send to agent](/help/20-send-to-agent). It is offered only for approved tracked Decisions, not for Request changes, Reject, release authorization, or legacy system records.

Agents can attach up to 12 supporting sources when requesting a decision. Compass validates that every source belongs to the same workspace and snapshots its title and version date into the immutable review packet. Supported product objects open in their detail panel, Docs open in the Docs workspace, and immutable Evidence snapshots remain readable in **Sources & Artifacts** even when they do not have a dedicated destination. Raw object IDs are not shown in the review UI.

## Decisions with options

A decision can be a question with a few possible answers instead of a plain yes/no. When requesting a decision, add **2 to 4 options**, each with a short label (up to 120 characters, unique within the request) and an optional description (up to 500 characters). Leave the options empty to keep the standard Approve / Request changes / Reject.

In the ballot, your options appear as selectable cards. **Request changes** and **Reject** are always offered as secondary actions alongside **Confirm choice**, so the decider can push back instead of choosing. Picking an option records it as an approval of that choice; the rationale is optional. Request changes and Reject still require a rationale, and the rationale box doubles as the free-text "something else" answer. The decided banner and the Decisions list show the chosen option's label (and the banner its description). The **Approved** outcome filter includes decisions resolved by choosing an option.

Agents can pass the same `options` list to `request_decision` and read the chosen option back with `get_decision`. Revising a request-changes decision keeps the previous options by default; the revision form lets you edit or clear them.

## Decisions with several questions

When one decision needs more than one answer, use the **Questions** section of the request form instead of a single set of options. Add **1 to 4 questions**; each has an optional short label (up to 40 characters), the question itself (up to 255 characters) and its own **2 to 4 options**. The top-level decision question stays the title of the request. Questions and the single **Answer options** editor are mutually exclusive: the form disables one while the other is in use.

The ballot shows each question as its own group of selectable cards with a single **Submit answers** button, which stays disabled until every question is answered. Submitting records an approval together with each answer. **Request changes** and **Reject** remain available as secondary actions; they apply to the whole request, need no answers, and still require a rationale. The decided banner and the Decisions list show every question with its chosen answer, and the **Approved** filter includes these decisions.

Agents pass `questions` to `request_decision` (never together with `options`) and read each answer back from `answers` on `get_decision`. Revising a request-changes decision keeps the previous questions by default; the revision form lets you edit or clear them.

## Supporting Artifacts

Wireframes and prototypes can be linked in the **Sources & Artifacts** tab beneath the primary linked subject. Workspace members select an active same-workspace Artifact with **Artifact to link** and choose **Link**. Open its title to view the current preview; **Unlink** removes only the relationship. Artifact detail shows reciprocal **Linked decisions** and also supports unlinking. A URL pasted into a discussion does not create this structured relationship.

Artifact rows show their current revision and archived status. They are **live supporting material, not frozen approval evidence**: they are separate from the captured **Sources** and never modify the immutable packet, fingerprint, Decision history, or outcome. Link changes work on both pending and decided requests and remain across request revisions. Existing archived links remain visible and removable, while newly linking archived Artifacts is disabled. Organization administrators who can read a Decision without workspace membership can see supporting rows but cannot edit Artifact relationships.

Agents use `link_artifact_to_decision` and `unlink_artifact_from_decision`. Both Decision MCP getters include live `artifacts`, and `get_artifact` includes `decisions`. Legacy system review requests do not support these links.

## Roadmap behavior

Authorized roadmap actions work directly in every ordinary horizon, including NOW. Moving an item to or from NOW does not require a policy, capacity plan, or special approval and does not emit shadow-evaluation telemetry.

## Release authorization

Release authorization is independent from roadmap decision tracking. Its existing immutable review and durable dispatch workflow remains available for teams that use it.

## Legacy history

Reviews previously created for NOW commitments or native policy activation are kept as read-only **Legacy system decision** records. Compass retains their database rows, evidence, and migrations for audit history, but no longer lets users decide, activate, or apply them. No operational configuration is required for this dormant historical data.
