---
title: "Custom Fields"
description: "Extend any object type with your own fields"
icon: "SlidersHorizontal"
order: 8
section: "Configuration"
---

# Custom Fields

Custom fields let you extend Compass object types with fields specific to your team's workflow. Common examples include "Customer Segment", "Confidence Score", "RICE Score", "Sprint", or "External Ticket URL".

## Creating Field Definitions

Go to **Settings → Custom Fields** to manage your field definitions. When creating a field, specify:

- **Name** — The field label displayed on objects (e.g. "Confidence Score")
- **Type** — One of:
  - `TEXT` — Free-form text
  - `NUMBER` — Numeric value
  - `DATE` — A date picker
  - `SELECT` — Single choice from a predefined list
  - `MULTI_SELECT` — Multiple choices from a predefined list
  - `URL` — A validated URL with a clickable link
  - `BOOLEAN` — A true/false toggle
- **Object Type** — Which type of object this field appears on (Opportunity, Experiment, Roadmap Item, etc.)
- **Options** — For SELECT and MULTI_SELECT, define the allowed choices

Field definitions are workspace-scoped and appear on all objects of that type across the workspace.

## Editing Options

SELECT and MULTI_SELECT options — on a new field, or in a **Shared option set** — are edited as a list, one row per option:

- **Add** — Type a label in the **Add option** box and press **Enter**. The box stays focused so you can type the next one straight away. Typed labels may contain commas.
- **Add several at once** — Paste a list into the **Add option** box, one option per line (list bullets are stripped) or comma-separated on one line. Each entry becomes its own option.
- **Rename** — Edit the label in place. Renaming never changes the option's stored value, so every record already tagged with it keeps its tag.
- **Color** — Click the dot at the start of a row to pick a color, or **No color**. Colored options show as colored chips.
- **Reorder** — Drag a row by its grip handle (⋮⋮) at the left. With the keyboard, focus the handle, press **Space** to pick the option up, **↑ / ↓** to move it, and **Space** to drop it (**Esc** cancels). You can also press **Alt+↑ / Alt+↓** while editing a label. On a phone, press and hold the handle briefly before dragging.
- **Remove** — Click the **×** at the end of a row.

Blank labels and duplicates (compared case-insensitively) are flagged inline and must be fixed before saving, rather than being silently dropped.

## Filling in Values

Custom field values appear in the detail panel of any object that has field definitions for its type. Click any field value to edit it inline. Values are saved immediately.

For an Opportunity single-select field, you can also set values in bulk by grouping the Discovery board by that field and dragging cards between its columns. See [Card sorting by a custom field](/help/02-discovery#card-sorting-by-a-custom-field).

Fields with no value set display a placeholder. Fields are always optional — an empty custom field does not affect the object in any way.

## Inheritance rules

An inheritance rule lets a roadmap item field start from a field on the Opportunity or Solution the item is linked to, so you do not have to copy values across by hand. For example, "Partner on roadmap items comes from Customer on the Opportunity", or, as a fallback, from "Investment Area".

Manage rules in **Settings → Custom Fields → Inheritance rules**. Pick the roadmap item field and the field to inherit from; both must have the same type, and for select fields the roadmap item field must offer every option the source can hold. Use the arrows to set priority when several rules fill the same field (the lowest priority with a value wins), the switch to turn a rule off without deleting it, and the bin to delete it. A rule whose options have drifted apart shows **Inactive** with the reason and is skipped until fixed.

Rules apply when a roadmap item is created with a link, when an existing item is linked to a different Opportunity or Solution, and when the source value is set later on an item that is already linked. They only ever **fill an empty field**:

- An existing value is never overwritten, including an explicit "No" or 0.
- Changing or clearing the source value afterwards does not change or clear the roadmap item's value; there is no ongoing sync.
- Unlinking does nothing, and re-linking does not rewrite a value that was inherited earlier.
- A source value set on an Opportunity or Solution fills at most 500 linked, active roadmap items with an empty field per write; the rest are noted in the server log and picked up by the next write for that source (items that are already filled take no slot). Archived items are never filled.

Agents can read the rules with `list_custom_field_inheritance_rules`, and `add_to_roadmap`, `promote_to_roadmap` and `update_roadmap_item` report what they filled in `inheritedFields`. Rules can only be created, reordered or deleted in Settings.

## Supported Object Types

Custom fields can be defined for:

- Opportunities
- Solutions
- Experiments
- Roadmap Items
- Objectives
