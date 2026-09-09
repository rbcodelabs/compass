---
title: "Detail panel"
description: "Click any card to see and edit its details in a side panel, and jump between related items"
icon: "PanelRight"
order: 14
section: "Core Features"
---

# Detail panel

Every card in Compass — an Objective, Key Result, Opportunity, Solution, Assumption, Experiment, Roadmap item, or piece of Feedback — opens a **detail panel** when you click its title. The panel slides in from the right, over whatever screen you're on, so you can look at (and edit) something without losing your place. It's the same panel everywhere: on the boards, on the OKRs page, and on [Canvas](/help/12-canvas) (where you click a node).

## Opening it

- **Click a card's title** on any board or list — OKRs, Discovery, Experiments, Roadmap, or Feedback.
- **Click a node** on Canvas.
- Press **Escape**, click the **✕**, or click outside the panel to close it.

## What's inside

Each panel shows the essentials for that item — its status, key fields, and the things it's connected to:

| Item | Shows |
|---|---|
| **Objective** | Status, cycle, and its Key Results |
| **Key Result** | Progress, its Objective, and any linked Opportunities and Roadmap items |
| **Opportunity** | Status, the Key Result it drives, linked feedback, its Solutions, and evidence |
| **Solution** | Status, its Opportunity, assumptions, and roadmap links |
| **Assumption** | Status, risk level, its Solution, and experiments |
| **Experiment** | Status, kill condition, the assumption it tests, and results |
| **Roadmap item** | Horizon, votes, and everything it's linked to |
| **Feedback** | Type, status, votes, linked Opportunity, and attachments |

## Discuss work in context

Every one of these eight panels includes a shared **Discussion**. Use it for working notes, questions, and follow-up that should stay attached to the Objective, Key Result, Opportunity, Solution, Assumption, Experiment, Roadmap item, or Feedback item.

![Shared Discussion in a Roadmap item panel](/screenshots/docs/shared-discussion-desktop.png)

- Add a comment or reply once to a root comment. Replies stay grouped in chronological order; threads are intentionally one level deep.
- Edit or delete your own comments. Workspace and organization administrators can moderate any comment.
- Resolve a finished thread to collapse it, then reopen it if the conversation needs to continue.
- A root with replies cannot be deleted as a single comment. An administrator can delete the whole thread only after confirming that every reply will also be removed.
- Comments posted by an agent are labeled **Agent**, and changed comments show **Edited**.

Anyone who can access the workspace can read and participate in its discussions. Items outside your workspace remain inaccessible.

On a phone, the panel and Discussion fill the available width while keeping the same actions:

![Shared Discussion on mobile](/screenshots/docs/shared-discussion-mobile.png)

### Comments are not decisions

A comment records conversation; it does not approve work, authorize a release, or change an item's lifecycle. Use [Decisions](/help/17-decision-reviews) when a named person must choose or authorize something.

Solutions have one additional, specialized surface: **Current Plan**. Plan updates remain separate from ordinary Discussion comments so the current proposal can stay pinned and retain its Approve/Reject workflow without duplicating conversation.

This first shared-Discussion release covers the eight detail panels above. A follow-up release will bring the same model to Tasks, Docs, Artifacts, Research Studies, and tracked Decision reviews; their existing specialized experiences remain unchanged for now.

## Jump between related items

The linked items in a panel are **clickable**. Open an Objective, click one of its Key Results, and the panel switches to that Key Result — from there click an Opportunity it drives, and so on. This lets you walk your whole opportunity-solution tree without leaving the panel or losing the thread. The browser **back** button steps back through the items you visited.

An Opportunity's **Driving Key Result** title and **Linked feedback** rows open the corresponding panels. Linked feedback includes a count and status labels; it is distinct from Evidence. These same navigation controls are also available on the opportunity's full page.

![Opportunity relationships in the desktop panel](/screenshots/docs/opportunity-links-panel-desktop.png)

![Opportunity relationships in the mobile panel](/screenshots/docs/opportunity-links-panel-mobile.png)

## Edit in place

You don't have to open the full page to make a quick change. In the panel you can:

- **Change the status** (or a Roadmap item's horizon) from the dropdown at the top.
- **Rename** an item — click its title and type.
- **Edit the description** — select **Edit** beside it and type. Descriptions support Markdown, including paragraphs, headings, lists, links, emphasis, code, and tables. Press **Enter** to save a title, or click away to save a description; press **Escape** to cancel.

Changes save immediately. For anything deeper, use **Open full page** at the top of the panel.

## Shareable links

The open panel is reflected in the page's web address, so you can **copy the URL and share it** — whoever opens it lands on the same screen with that item's panel already open. Refreshing the page keeps it open too. (Only people who are members of the workspace can open it — the panel never exposes items from a workspace you're not in.)

## Not yet available

- Clicking a card **anywhere on it** — for now the **title** is the click target; the rest of the card keeps its existing behavior (drag to reorder, quick-action menus).
- A **docked, resizable** panel that sits beside the content instead of over it — planned for a future update.
