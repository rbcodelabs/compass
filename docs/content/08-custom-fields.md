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

## Filling in Values

Custom field values appear in the detail panel of any object that has field definitions for its type. Click any field value to edit it inline. Values are saved immediately.

For an Opportunity single-select field, you can also set values in bulk by grouping the Discovery board by that field and dragging cards between its columns. See [Card sorting by a custom field](/help/02-discovery#card-sorting-by-a-custom-field).

Fields with no value set display a placeholder. Fields are always optional — an empty custom field does not affect the object in any way.

## Supported Object Types

Custom fields can be defined for:

- Opportunities
- Solutions
- Experiments
- Roadmap Items
- Objectives
