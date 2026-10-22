---
title: "Specs and Discovery Plans"
description: "Write a Spec for a solution or a Discovery Plan for an opportunity as a document whose cards stay live"
icon: "FileText"
order: 29
section: "Core Features"
---

# Specs and Discovery Plans

A **Spec** is a document about one **solution**. A **Discovery Plan** is the same kind of document about one **opportunity**. Both are ordinary [Docs](/help/06-docs): you write in markdown, and wherever you point at a Compass record the document shows a **live card** with that record's current title, status and key facts. Nothing in the document needs to be updated by hand when the record changes.

Specs and Discovery Plans are optional. A workspace that never creates one looks exactly as before.

## Where to find them

- **On a solution**, the **Specs** section lists every spec for it, most recently updated first, then a **New spec** button.
- **On an opportunity**, the **Discovery Plans** section lists every plan for it in the same way, then a **New plan** button.
- A solution can have several specs and an opportunity several plans. **New spec** and **New plan** always make another document, and the buttons create it without a label. To tell several apart, rename the document, or have an agent create it with the optional `label` of `create_spec` (for example "v2" or "Pricing"); the label is then shown beside the document in the list.
- Members with read-only access can open and read specs and plans but do not see the **New** buttons.

Creating one pre-fills the document from the record's real children: a Spec starts with the key results, assumptions, experiments and prototypes already linked to the solution; a Discovery Plan starts with the opportunity, its solutions and its riskiest open assumptions. Edit the text freely.

On the document page a label tells you what it is: **Spec** when it belongs to a solution, **Discovery Plan** when it belongs to an opportunity, and **Spec (unscoped)** with a notice when the solution or opportunity it was written for has since been deleted. The document itself is never changed or deleted by that.

## Embedding a record

An embed is an ordinary markdown link to a `compass://` address:

```
[Checkout redesign](compass://solution/0b7e3c9a-5d1f-4f6e-8a2b-9c4d5e6f7a8b)
```

- **Alone in its own paragraph**, the link shows as a **card** with the record's kind, status and key facts, and a link to open it.
- **Anywhere else** (inside a sentence, a list or a quote), it is a plain link with that text. Other tools that read the markdown see a normal link too.
- The text in the square brackets is a **cached title**, only a hint for readers of the raw markdown. Compass never shows it on a card: the card always shows the record's current title, so a renamed record is correct everywhere without editing the document.
- Loading a card never edits the document. Editing a card (below) changes the record, not the document.

The kinds you can embed are `opportunity`, `solution`, `metric`, `doc`, `task`, `experiment`, `objective`, `keyResult`, `assumption`, `roadmapItem` and `artifact`. The id must be the record's UUID, from the same workspace as the document.

Archived and killed records still show as cards, with their status. That is information, not an error.

## Record unavailable

A card reads **Record unavailable** when Compass cannot show it. It may mean the record was deleted, the id is wrong, the record belongs to a different workspace, or you do not have access to it. Compass deliberately does not say which, so a document can never be used to find out whether a record exists elsewhere. Nothing in the document is changed: the link stays as written until someone edits it. If you can edit the document, the card has a **Remove** button (see below).

Documents with many embeds load their cards as you scroll to them.

## Editing from the document

If you can edit the workspace (read-only members see none of this), the cards and the editor give you three tools. None of them is a new kind of permission: each does exactly what the same action does on the record's own page.

### Editing a card

- **Rename**: the pencil beside a card's title opens the title for editing. Press Enter to save, Escape to cancel. An empty title is not saved.
- **Status**: the status on a card is a menu. Pick a value to change it.
- Cards for assumptions, solutions, experiments, tasks, opportunities and objectives offer both; key result cards offer rename only. Metric, doc, artifact and roadmap item cards are not editable from a document. Open them with the card's link.
- Each edit shows **Saving...** and then **Saved** on the card. If it fails, the card goes back to the record's real value and says so.
- A card edit changes the **record**, not the document. It does not trigger the document's autosave, and the cached title in the markdown is left exactly as written. The card keeps showing the live title, so nothing looks different; the cached title is only refreshed if someone edits that link on purpose.

### The "/" menu

In a Spec or Discovery Plan, type `/` at the start of an empty line to open a small menu:

- **Assumption** (Specs): creates a new assumption on the solution the Spec is for.
- **Task** (Specs and Discovery Plans): creates a new task linked to the Spec's solution, or to the Discovery Plan's opportunity.

Choose one, type a title, and press Enter (or **Create and insert**). Compass creates the record and then replaces the line with its card. Keep typing after `/` to filter, use the arrow keys and Enter to choose, and press Escape to close the menu. On a phone, tap an entry. A Spec whose solution has been deleted ("Spec (unscoped)") has no menu, because there is nothing to create the record under.

If creating the record fails, nothing is added to the document and you can try again. If the document's autosave fails after the card is inserted, the new record still exists. Experiments are not in the menu because creating one needs a hypothesis, a method and a kill condition; create it on its page, then paste its link as an embed.

### Removing a card

Choose **Remove** on a **Record unavailable** card, or **Remove from document** in the actions menu of any other card. This deletes only that card's line from the document, and saves like any edit. It never deletes the record.

## Agents

Agents can create, list and read these documents with `create_spec`, `list_specs` and `get_spec`; `get_spec` returns the markdown together with each embed's live title, status and facts, and lists any that are unavailable. See [Specs and Discovery Plans in the MCP API](/help/09-mcp-api#specs-and-discovery-plans).
