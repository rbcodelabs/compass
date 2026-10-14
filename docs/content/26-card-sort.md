---
title: "Card sort"
description: "Prioritize by proposal instead of by edit: a team proposes moves between buckets, and the facilitator reveals the tally"
icon: "Shuffle"
order: 26
section: "Core Features"
---

# Card sort

A card sort is a repeatable "propose a move" exercise. Everyone in the workspace looks at the same list of items, each sitting in a bucket (for example **Must / Should / Could**), and proposes moving the ones they disagree with. Nothing they propose changes the official value. The facilitator later reveals a tally so the team can see where opinion differs before anyone edits anything.

Open it from **Discovery → Card sort** (to sort Opportunities) or **Roadmap → Card sort** (to sort Roadmap Items), or go to `/<org>/<workspace>/card-sort`. The page has a switch for which object type a new round is about, and the round list shows every round with its object type.

## Rounds

A **round** is one run of the exercise. Rounds exist so it can be repeated: this quarter's tally is never polluted by last quarter's proposals.

A round is built from:

- **A factor** — any single-select custom field on the object type being sorted. The field's options are the buckets. If the field is backed by a shared option set, the round follows the set, so editing the set is reflected immediately. Multi-select fields are not offered, because "move this to X" has no clear meaning when an item already holds several values.
- **An object type** — taken from the factor, never chosen separately: Opportunities, Solutions, Experiments, Objectives, Key Results, Roadmap Items or Tasks.
- **A name**, for example "Q1 prioritization".

Whoever creates the round is its **facilitator**.

### Round states

| State | Who can see proposals | Proposals accepted |
| --- | --- | --- |
| **Open** | Each person sees only their own. The facilitator sees everyone's. | Yes |
| **Revealed** | Anyone who can read the workspace sees the tally. | No |
| **Closed** | Same as revealed. | No |

Revealing and closing are **one-way** and **facilitator-only**. Both ask for confirmation first, because a tally that has been read cannot be un-read. Closing archives the round; it cannot be reopened.

While a round is open, its total proposal count is visible to everyone, since it names no item, target or person. Everything else about other people's proposals stays hidden.

## Proposing a move

Two views show the same round; the toggle in the header switches between them at any time.

- **Kanban** — one column per bucket, plus a column for items with no value yet. Drag a card to another column, right-click it, or use its **…** menu. Drag it back, or press **×**, to withdraw. The card left behind is shown as a ghost so you can see where it started.
- **Table** — one row per item. Right-click a row or use its **…** menu, or tick several rows and propose one move for all of them.

### Filtering the board

Both views have a **Filter cards** box. Type any words to show only the items whose title, description or squad contains all of them, in any order and ignoring case: `export slow` and `slow export` both match "Slow CSV exports". A readout shows how many items match (for example **2 of 8**). Press **Esc** or the **×** to clear it.

The filter only changes what you see:

- Column counts still show how many items are *officially* in each bucket, including ones the filter hides.
- In the table, **Select all** and the bulk proposal act only on the rows you can see. Selected rows that a new filter hides are deselected, so a bulk move never reaches an item you can't see.

Rules that apply to both:

- Each person has **one proposal per item**. Proposing again replaces your earlier one; it is never counted twice.
- A proposal must go to a *different* bucket than the item's current value. "Leave it where it is" is not an opinion and is rejected.
- You can add a short rationale.
- The current value is recorded on the server at the moment you propose, so the tally still makes sense after the official value is later changed.
- **No proposal means no opinion recorded, not agreement.** Proposals are sparse — only disagreements are stored — so there is deliberately no "% who agree" anywhere.

## Proposing a new entry

In a round over **Opportunities** or **Roadmap Items**, a participant can also propose that a brand-new one be added: a title, an optional description, and optionally the bucket they think it belongs in.

A proposed entry is **not** an Opportunity or Roadmap Item. It is a pending request held on the round, and nothing in your tree or roadmap changes until the facilitator accepts it:

- **Accept** creates the real Opportunity — or, in a Roadmap Item round, a Roadmap Item in the **Later** horizon (never Now, so accepting can't bypass the Now-commitment review; move it from the Roadmap afterwards) — and the proposer's suggested bucket becomes their ordinary proposal on it (never the official value).
- **Reject** keeps a note visible to the proposer.

Like proposals, entries are blind while the round is open: only the proposer and the facilitator can see them.

## The tally

Once a round is revealed or closed (and always for the facilitator), **Tally** shows what people proposed:

- **Table** — per item, the proposed moves and who proposed them, with rationales.
- **Flow** — arrows between buckets, weighted by the number of proposals for that move. A column with no outgoing arrows is one nobody asked to change, not one the round endorsed.

Net figures are inflow minus outflow. Every move leaves one bucket and enters another, so they sum to zero unless some proposals came from items with no value yet.

### Exporting the tally

Use **Export CSV** on the tally page to download the tally as a spreadsheet-ready file, one row per proposal: the item, its current value, the proposed value, the proposer, their rationale, how many proposals the item has, and how many different targets were proposed. The export is built from the same data as the tally page, so it follows the same rule: while a round is open, nobody but the facilitator gets the file (the request is refused rather than returning an empty file). Text that starts with `=`, `+`, `-` or `@` is prefixed with an apostrophe so spreadsheets do not run it as a formula.

The tally never changes the official field value. Reconcile the official values yourself, in the usual way, once the team has seen it.

## Access

- Any workspace member can create a round, and proposes and withdraws in open rounds.
- Only the round's creator can see others' proposals while it is open, resolve proposed entries, reveal it, or close it.
- Reading a round, its board and its own proposals is a normal member read. The tally is refused for everyone else until the round is revealed.

## MCP

Agents can read rounds and boards but, by design, **cannot write**. The tool list is in the **Card sort** section of the MCP & API page.
