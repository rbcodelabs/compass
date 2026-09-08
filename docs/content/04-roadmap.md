---
title: "Roadmap"
description: "Plan and communicate what you're building across Now, Next, and Later horizons"
icon: "Map"
order: 4
section: "Core Features"
---

# Roadmap

The Roadmap is a three-horizon view of what your team is building. It stays intentionally lightweight by default — communicating direction and priority without forcing you to predict dates beyond the near term — but once an item's timing is known, adding a start and end date turns its placeholder bar on the Timeline view into a real, dated one.

Each internal roadmap card and Timeline bar shows a delivery-status badge derived from tasks directly linked to that roadmap item. Blocked work takes precedence, followed by In Review and In Development; an item is Complete only when every non-cancelled linked task is done. Items with no active linked tasks remain Not Started. This delivery lifecycle is independent of the item's roadmap horizon.

Open a Roadmap item's detail panel to discuss it with the team. Shared Discussion supports replies, editing, resolution, and safe moderated deletion; see [Detail panel](/help/14-detail-panel#discuss-work-in-context).

![Roadmap](/screenshots/docs/roadmap.png)

> 📸 Screenshot: run `pnpm docs:screenshots` with a `DOCS_SESSION_FILE` to capture this image.

## The Four Horizons

- **Now** — Work that is currently in flight. Your team is actively building or shipping these items. Keep this column short and honest: if it's not genuinely in progress, it belongs in Next.
- **Next** — Committed work coming up after Now items ship. These items have been prioritised and are ready to start. They have enough detail and justification to begin when capacity opens.
- **Later** — Directional bets you're exploring but haven't committed to yet. Items here are placeholders for things that are likely important but whose timing and scope aren't settled.
- **Shipped** — A visible board column of its own (styled with a purple accent, like Now/Next/Later), used to keep a record of completed work. Drag a card into Shipped, or promote it there directly, to mark it delivered without deleting it — so stakeholders can still see what's shipped and trace it back to the opportunity and solution behind it.

## Creating Roadmap Items

Click **+ Add Item** in any horizon column. A roadmap item has:

- **Title** — What you're building
- **Description** — Why you're building it
- **Horizon** — Now / Next / Later
- **Linked Opportunity** — The customer problem this solves
- **Linked Solution** — The specific solution approach
- **Linked Key Result** — The outcome it contributes to
- **Linked Experiment** — The experiment that validated the approach
- **Squad** — Team assignment
- **Start date / End date** — Optional. Leave these blank for items whose timing isn't settled yet — the item still appears on the Timeline as a dashed placeholder bar you can drag to schedule; fill them in (here, via Edit, or by dragging the bar) once you know when the work will happen.
- **Private** — Optional checkbox. Hides the item from the public portal roadmap and blocks voting on it, while still showing it (with a 🔒 Private badge) on the internal Board and Timeline. Use it for items you don't want visible to customers — security fixes, sensitive internal work, anything you'd rather not telegraph externally.

The linked metadata appears as small icon badges on each card, giving stakeholders a quick way to trace the evidence behind each item. Use a card's **Edit** menu action at any time to add or change its title, description, dates, linked opportunity, or private status. Choose **None** in the Opportunity picker to remove an existing opportunity link.

## Timeline View

Toggle between **Board** and **Timeline** at the top of the Roadmap page. Board remains the default. Use **Filters** beside the view control to focus either view on a squad. The Timeline view is linkable: `?view=timeline` takes you straight there, and the squad filter carries over from the Board.

### Native timeline preview — Compass workspace only

The `rbcodelabs/compass` workspace uses the **Compass native timeline** by default when you select Timeline. Other workspaces continue to use the classic timeline. This initial rollout is tied to the workspace's identity; adding a URL parameter cannot enable it in another workspace.

The native chart groups items by horizon and squad, with separate tracks for overlapping bars. Use **Month** or **Quarter** to change the visible planning range, **Previous / Next** to navigate, and **Today** to return to the current period. Scroll horizontally to reach dates outside the visible area.

The native timeline follows your workspace's Light, Dark, or System appearance preference, including its calendar, squad labels, backlog, and date editor. Horizon colors remain consistent across themes.

Drag the **dotted move handle** just inside a bar's left edge to move its dates. Slim grips on the **left and right borders** resize the start and end dates; their invisible hit areas are wider than the visible grips and stay separate from the move handle. The compact controls leave more room for the title, which opens the item's details when clicked. Narrow bars hide status and overlap badges to prioritize the title; both remain available to screen readers, and delivery status is also shown in the item's details.

Keyboard controls and an **Edit dates** dialog offer alternatives to dragging: focus the move handle and use **Alt + Left/Right** to shift dates, or **D** to open the date dialog; use **Left/Right** on either resize grip to adjust that edge. Narrow bars keep the dialog when there is not enough space for separate controls. Dates are inclusive, and changes save immediately. Items without dates use placeholder dates until scheduled. Launching and Launched items are display-only in this chart; use the existing launch workflow to manage them.

Select **Use classic timeline** above the chart to switch back at any time, or **Use native timeline** to return. These links preserve the selected squad. The classic fallback is also directly linkable with `?view=timeline&timelineEngine=classic`.

![Native timeline on desktop](/screenshots/docs/native-timeline-1280.png)

![Native timeline on mobile](/screenshots/docs/native-timeline-390.png)

**Preview limitation:** this rollout is intended for single-writer use. An item deleted elsewhere can remain visible during the current session. Conflicting edits can disable further editing of an item. Reload the browser page before continuing in either case; a background refresh is not sufficient. This preview does not provide full multi-user synchronization.

### Classic timeline

The classic timeline remains available in every workspace. It renders every roadmap item as a bar on a Gantt-style chart, colored by horizon, so you can see what's planned to run concurrently and spot scheduling conflicts. Items that don't have a start and end date yet still appear — as a dashed, outlined bar starting today — so you can drag or resize them directly to set real dates instead of hunting for the Edit dialog. A count above the chart calls out how many items are still on placeholder dates.

Drag a bar to shift its dates, or resize it from either edge to change its start or end date — changes save immediately. The Timeline view is linkable: `?view=timeline` in the URL takes you straight there, and the squad filter carries over from the Board.

Use the **Day / Week / Month / Quarter / Year** tabs above the chart to zoom the timeline in or out. Day is the default (and shows the most detail); zooming out to Month, Quarter, or Year is useful for spotting overlaps and gaps across a longer planning horizon without scrolling.

Use **Group by** to cluster items into collapsible sections instead of one flat list. Currently supports grouping by **Squad** — items nest under a colored summary row per squad (matching that squad's color from Settings), with a **No squad** section for anything unassigned. Each summary row's date range spans its items and can be collapsed independently; it isn't itself draggable, since its dates are a computed range rather than something stored on a single roadmap item.

## Not Yet on the Roadmap

Compass surfaces validated or in-delivery Solutions from Discovery, and Bug-type Feedback items, that don't have a roadmap item yet. These are the same items that already have a "Promote to roadmap" action on the Discovery solution card or the Feedback board; this is a second entry point that lets you schedule them without leaving the roadmap.

- **On the Board** — these candidates live in an always-visible **Not scheduled** Kanban column after Shipped. Drag a card from it onto any roadmap horizon to schedule it there, or use its **⋯** menu to add it directly to Now/Next/Later without dragging. The column remains visible when empty so the board layout stays consistent.
- **On the classic Timeline** — candidates remain in the **Not yet on the roadmap** panel below the chart. Drag a card onto the chart area to open a small dialog for setting its horizon and start/end dates, since the Gantt chart has no way to infer a date purely from where you drop something. The panel's quick-add menu still works here too — it schedules the item without dates, which now shows up immediately on both the Board and the Timeline (as a dashed placeholder bar you can drag to set real dates).
- **On the native Timeline preview** — the same **Not yet on the roadmap** panel remains below the chart. Drop a card on a compatible Now, Next, or Later lane to schedule it at the drop date, or use the panel's quick-add menu without dragging. Squad-linked solutions must stay in their own squad's lane. Pending items cannot be submitted again while their save is in progress.

Ideas (as opposed to Bugs) aren't included in this panel — they're expected to go through Opportunity → Solution discovery first, same as everywhere else in Compass.

## Drag to Reorder

Within each horizon, drag cards to reorder them. Order within a horizon communicates relative priority: items higher in the list are higher priority. This ordering is persisted and visible to all workspace members.

## Launch Tiers & Checklists

Moving a roadmap item into the Launching phase requires picking a launch tier: Tier 1 (major launch), Tier 2 (minor launch), or Tier 3 (silent launch). Setting a tier attaches a checklist cloned from your workspace's active checklist template for that tier, and moves the item to the LAUNCHING horizon. Once launching begins, the item cannot be moved back through the tier-selection step, since the roadmap is tracking a real-world GTM commitment, not just an internal work status.

Checklist templates are workspace-owned and reusable: define one per tier (for example, a Major Launch Checklist for Tier 1 with items like Write launch announcement, Brief support team, and Update pricing page), and every future Tier 1 launch reuses it. Each launch gets its own frozen copy of the checklist at attach time, so editing a template later does not retroactively change checklists already in flight. Checklist items are tracked as Pending, Done, or Skipped, since Skipped exists so a genuinely inapplicable item does not block completion the way an incomplete Pending item would.

This is currently managed via the MCP API (set_launch_tier, get_launch_checklist, update_launch_checklist_item, create_checklist_template). No dedicated UI ships yet.

## Keeping the Roadmap Honest

A roadmap that isn't updated is worse than no roadmap — it creates false confidence. Compass is designed to make updates low-friction: drag to move between horizons, click to update details. The links to opportunities, KRs, and experiments mean the roadmap is always one click away from the evidence behind it.

## Public Roadmap (Portal)

If your workspace has **Public Roadmap** enabled (see [Enabling the Portal](/help/05-feedback#enabling-the-portal) in Feedback Portal — the same workspace-wide toggle controls both feedback and roadmap visibility), visitors can view your Now / Next / Later items at `/portal/[org]/[workspace]/roadmap` and vote on the ones they care about.

Each roadmap card on the portal shows a vote button with the current count. Hovering over a card expands its description if it's been truncated, so visitors can read the full context before voting. Voting follows the same account rules as feedback submission — if **Require an account to submit/vote** is on, visitors verify their email via magic link (or arrive pre-verified via SSO Identify) before voting; otherwise a name (optional) and email (required) are collected inline.

If **Public Feedback** is also enabled for the workspace, a **Give Feedback** link appears in the roadmap page header so visitors can get to the feedback portal without knowing the URL.

Roadmap items marked **Private** are excluded from the portal entirely — they never appear in the list and the vote API rejects votes on them directly, even if someone learns the item's ID some other way. Private items are still fully visible internally, so use the flag purely as a visibility control, not a way to hide something from your own team.
