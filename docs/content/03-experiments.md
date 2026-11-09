---
title: "Experiments"
description: "Validate assumptions with structured experiments before committing to build"
icon: "FlaskConical"
order: 3
section: "Core Features"
---

# Experiments

Hypotheses, methods, kill conditions, and result notes support Markdown on experiment details. Compact experiment cards remain short plain-text previews.

Experiments let you test the riskiest assumptions attached to your solutions before your team commits to building. Every experiment in Compass has a structured lifecycle that forces you to define success criteria upfront — preventing you from rationalising inconclusive results as successes after the fact.

![Experiments page](/screenshots/docs/experiments.png)

On mobile, each column fills the available board width with small side gutters. Swipe sideways to reach the next column.

![Experiments page on mobile](/screenshots/docs/experiments-mobile.png)

> 📸 Screenshot: run `pnpm docs:screenshots` with a `DOCS_SESSION_FILE` to capture this image.

## The Experiment Lifecycle

On touch screens, swipe over card content to scroll vertically or move horizontally between board columns. Use the dotted drag handle to move a card instead. On desktop, column headers stay visible while their cards scroll.

Experiments move through these statuses:

- **DESIGNING** — The experiment is being planned. You're writing the hypothesis, deciding on the method, and defining kill conditions.
- **RUNNING** — The experiment is live. Data is being collected.
- **COMPLETE** — The experiment ran to completion and produced a conclusion.
- **KILLED** — The experiment was stopped early (for ethical, business, or resource reasons) before reaching the planned end condition.

Use **Filters** at the top of the page to focus the experiment board on a specific squad. Clear the selected squad from the same menu to return to the full board.

### Pin, collapse and reorder columns

The Experiments board uses the same **dock** as the [Tasks board](/help/13-tasks#pin-collapse-and-reorder-columns-on-the-board), the [Opportunity board](/help/02-discovery#pin-collapse-and-reorder-columns-on-the-opportunity-board), the Solutions backlog and the Roadmap board. On a wide screen (the medium breakpoint and up), any status column can be **pinned**: it moves into one dock on the right, outside the scrolling area, so it stays put while the other columns scroll. **Complete** and **Killed** are natural candidates, since they sit at the far end of the board. Nothing is pinned until you pin it, so the board looks the same as before.

The dock is **one slot**, however many columns you pin: a panel showing one pinned column, with a narrow rail of **tabs** at its right edge, one per pinned column (its name and experiment count). Pinning more columns adds tabs; it never makes the dock wider.

- **Pin or unpin.** Use the pin button in a column's header (it appears when you hover the header) or **Pin to the right** / **Unpin** in the column's **⋯** menu. A pinned column becomes the active tab and the dock opens on it.
- **Switch and collapse.** Click a tab to show that column. Click the active tab, or the **Collapse** button in the panel's header, to close the panel and leave only the tab rail. Arrow keys move between tabs; Enter or Space shows one.
- **Drag experiments.** A tab is a drop target even while the dock is closed: drop a card on the **Killed** tab and its status becomes Killed. Cards in the open panel can be dragged out to any other column, and dragging a card up or down within a column still sets its order. Pressing **Escape** during a drag puts the card back.
- **Reorder columns.** **Move left** / **Move right** in a column's **⋯** menu. A pinned column's place in that order is its place among the tabs. This order replaces the fixed Designing to Killed order.
- **Narrow screens.** Below the medium breakpoint nothing is docked: pinned columns appear in the scrolling board in their saved order, one swipe column each, and the pin button is hidden. Your layout comes back when the screen is wide again.

The layout is remembered **in this browser**, for each workspace. The Experiments board has no saved views, so it does not follow you to other devices.

## Gallery View

Toggle to **Gallery** beside **Board** at the top of the Experiments page (or open `?view=gallery`) to browse experiments as large, image-first cards. Each card shows a screenshot of an Artifact [linked to the experiment](#linking-artifacts), with the experiment's title, status, hypothesis, squad and, once it is concluded, its conclusion beneath it.

- **Several artifacts.** When an experiment has more than one Artifact, a small filmstrip of up to three thumbnails sits on the preview (plus a **+N** count for the rest). Hover, focus or click a thumbnail to swap the preview. Newest artifacts come first, and the card opens on the newest one that has a screenshot. Archived artifacts are not shown.
- **No preview yet.** If an Artifact is linked but has no screenshot, the card shows a placeholder with **Capture preview** (HTML uploads and external links) to take one. v0 chats cannot be screenshotted and link to the artifact instead.
- **Nothing linked.** An experiment with no linked Artifact still appears, with a hatched placeholder that tells you to open the experiment and link an artifact from its panel.
- **Group by** — Status (default, in the Board's column order), Squad, Conclusion, or None. Group headings are collapsible and show counts. The grouping lives in the URL (`?groupBy=`), and switching back to Board drops it.
- Click a card to open the usual experiment panel. The squad filter works in Gallery like on the Board, and the Gallery refreshes live when experiments change. The Gallery is read-only: to change a status or the order, switch back to Board. Your Board column layout (pinned columns, dock) is kept while you look at the Gallery.

## Creating an Experiment

Click **New Experiment** on the Experiments page, or click **Test this assumption →** next to any untested assumption in Discovery's OST Tree view — that pre-fills the assumption picker below so you don't have to hunt for it. Either one opens the experiment composer in the right-hand panel. On wide screens it docks beside the board; on narrow screens it opens as a full-width sheet. Fill in:

- **Title** — A short name for the experiment (e.g. "Trial expiry email A/B test")
- **Hypothesis** — A falsifiable prediction in the format: *"We believe [action] will result in [outcome] for [audience], as measured by [metric]."*
- **Method** — How you'll run the test (A/B test, user interview series, fake door, prototype test, etc.)
- **Kill conditions** — The conditions under which you'll stop the experiment early (e.g. "If conversion rate drops below 2% in the first 48 hours, stop")
- **Squad** — Optional team assignment
- **Linked assumption** — Connect the experiment to the specific assumption from Discovery that it's testing
- **Metrics** — Optional. Pick existing workspace metrics to track on the experiment. They are linked over the last 30 days once the experiment exists; add comparison periods from the experiment afterwards. If a metric can't be linked, the experiment is still created and the composer tells you which metrics were skipped.

Press **⌘/Ctrl + Enter** or select **Submit** to create the experiment. The composer then turns into the new experiment's detail panel. Your draft is saved on this device for each workspace as you type: closing the panel, reloading or leaving the page keeps it, and the composer says **Restored your unsent draft** the next time you open it. Discarding a draft asks for confirmation first.

## Linking Research Studies

Open an experiment's detail panel or full page and find **Informed by** (research studies) below its method. Choose **Link existing research study** to search for a customer interview or usability study in the same workspace. Linked studies show their status and let you open the study or unlink it. You can also manage the relationship from the study's **Informs** (experiments) section in Capture.

One experiment can link to several studies, and the same study can support several experiments. Draft, active, and closed studies can be linked; archived studies keep existing links (still visible and removable) but cannot receive new ones. PM interviews and imported external studies do not appear in this picker. Research must be enabled for these controls to appear.

A link records relevance, not validation. It does not create a study, change its participant guide, activate it, record an experiment result, or update an assumption. Links remain editable after participant sessions start and at every experiment status. Unlinking removes only the relationship, not the study or its research. The same relationship is available to agents through `link_entities` with link type `EXPERIMENT_INFORMED_BY_STUDY`.

## Linking Artifacts

An experiment can run on a prototype, deck or reference that lives in Docs as an **Artifact**. Open an experiment's detail panel or full page and find **Linked artifacts** below its method. Choose **Link existing artifact** to search for an active Artifact in the same workspace; linked artifacts show their status and let you open the artifact or unlink it. You can also manage the relationship from the other side: an Artifact's page lists **Linked experiments** with the same controls. These sections appear in every workspace, whether or not Research is enabled.

One experiment can link to several artifacts, and one artifact can support several experiments. Archived artifacts cannot receive a new link, but links they already have stay visible and removable. Linking changes nothing else: it does not create or revise the artifact, change the experiment's status, or record a result, and unlinking removes only the relationship. Deleting an artifact (or the workspace) removes its links. Agents use `link_artifact_to_experiment` and `unlink_artifact_from_experiment`; `get_artifact` returns `experiments`, `get_experiment` returns `linkedArtifacts`, and `list_artifacts` accepts an `experimentId` filter.

## Recording Results

Once an experiment is COMPLETE or KILLED, open the detail panel and click **+ Add Result**. Record what you observed: the actual metrics, any qualitative findings, and unexpected outcomes.

## Conclusions

Every experiment ends with a conclusion that tells the team what to do next:

- **PROCEED** — The hypothesis was supported. Move forward with the solution.
- **KILL** — The hypothesis was refuted. Abandon this solution direction.
- **ITERATE** — The results were mixed or inconclusive. Refine the solution or hypothesis and run another experiment.

Conclusions are inputs to the Roadmap. When an experiment concludes PROCEED, it provides strong justification for adding the linked solution to the roadmap. When it concludes KILL, the linked opportunity may need to return to VALIDATING status.

## Linking Back to Discovery

Each experiment is linked to an assumption in Discovery. This connection means you can see, on any solution, which of its assumptions have been tested and what the outcomes were — giving stakeholders a complete evidence trail for every roadmap decision.
