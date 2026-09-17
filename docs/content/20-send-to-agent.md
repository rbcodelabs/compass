---
title: "Send to agent"
description: "Open the in-app agent from an approved plan or decision with its context already attached"
icon: "Sparkles"
order: 20
section: "Core Features"
---

# Send to agent

Approving work and acting on it are separate steps. **Send to agent** connects
them: from an approved Solution plan or a decided Decision, open the Compass
in-app agent in a new conversation that already knows what was approved, instead
of describing it again from memory.

This is an entry point to the existing in-app agent, not a separate assistant. The
agent still runs with your own workspace permissions and the workspace's enabled
[capability packs](/help/18-agent-capability-packs).

## Where it appears

**Send to agent** is deliberately limited to work that has actually been approved:

- **Solution plans.** In the Solution detail panel's **Plan & Discussion**
  section, next to **Approve** and **Reject**, once the current plan is
  approved. A pending or rejected plan does not show the action.
- **Decisions.** On a decided Decision, in the recorded-decision banner, when the
  chosen outcome was an approval. Outcomes of **Request changes** or **Reject**
  do not show it.

Release authorization and legacy system decision records share the same decided
banner but do not offer this action. It applies to ordinary tracked Decisions
only.

## What happens when you use it

Selecting **Send to agent** opens a new agent conversation with two things
prepared:

- A **context chip** above the message box, naming the plan or decision and
  linking back to it.
- A **suggested instruction** already typed into the message box.

Nothing is sent automatically. The suggested instruction is ordinary editable
text — replace it entirely if what you want is different from what Compass
guessed. An agent turn only starts when you send it, so arriving here never
consumes turns or counts against usage limits on its own.

Dismiss the chip with its **×** to send the message without the attached
context. Dismissing the chip does not clear anything you have typed.

## What the agent receives

The attached context is resolved fresh when you send, from the plan or decision
itself — not from the link you followed. A long decision context is shortened,
with a pointer back to the source for the full text.

Context is attached to the **first message only**. Later messages in the same
conversation do not re-send it, so a long conversation does not keep paying for
the same attachment. To attach it again, or to attach a different plan or
decision, start a new conversation from that item.

Your conversation history records only the message you actually typed. The
attached context is never stored as though you had written it.

## If the work changes before you send

A plan can be rejected, or a decision reopened, between opening the agent and
sending your message. When that happens the message still sends — without the
attached context, and without an error. Compass does not attach context from work
that is no longer approved.

The same applies to a stale or shared link: following one for an item you cannot
access, or that no longer exists, opens an ordinary empty agent conversation with
no chip and no prefilled text. Access is always evaluated against your own
workspace membership, so a link does not grant anyone visibility they did not
already have.

Reopening an existing conversation never prefills the message box or restores a
chip, even if that conversation originally started from an approval.

## Viewing Compass inside Geode

If Compass is open inside Geode's Web Viewer, **Send to agent** becomes a small
menu instead of a single button: **Built-in cloud agent** (everything above,
unchanged) and **Geode**, which hands the same context to a local Geode Agent
Threads runtime instead of Compass's own in-app agent. Outside Geode — i.e. every
normal browser — nothing changes; the single-button behavior above is exactly
what you see.
