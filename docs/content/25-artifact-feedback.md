---
title: "Artifact feedback"
description: "Leave element-anchored feedback directly on a Compass-hosted artifact"
icon: "MessageSquarePlus"
order: 25
section: "Core Features"
---

# Artifact feedback

[Embedded feedback](/help/24-embedded-feedback) covers a prototype hosted
somewhere else — a Vercel preview, a staging site. For a prototype you
**uploaded into Compass** (an HTML Artifact rendered in Docs), leave feedback
directly in the artifact viewer instead. No script tag, no separate token —
it uses your existing Compass sign-in.

## Leaving feedback

Open an HTML Artifact and press **Leave feedback** above the preview. Click
the element you want to comment on, then write your comment and post it. The
comment is an ordinary comment on the artifact — it also shows up in the
**Comments** panel, and can be replied to, edited, resolved, or deleted there
like any other thread.

Picking an element never activates it: a click while picking is captured and
never reaches the prototype's own buttons or links, so you cannot
accidentally submit a form or navigate away while leaving feedback. Press
**Escape** to cancel picking without leaving a comment.

## Pins

A comment left this way is anchored to the element you clicked and renders as
a pin over it the next time the artifact loads. Compass re-locates the
element by its selector first; if the page has changed enough that the
selector no longer resolves, it falls back to a scored match against the
element's recorded position and text.

When neither is confident enough, Compass shows a banner ("N pinned
comments could not be re-anchored precisely") instead of guessing — a pin is
never positioned at an element it isn't confident is the right one.

## Full-screen view

Press **View full screen** to open the artifact at full viewport width in its
own page, with the same picker and pins. **Back to artifact** returns to the
docked view.

## What this does not cover

- **External reviewers and portal visitors** cannot use this picker — it
  authenticates through your normal Compass session. To collect feedback from
  people without a Compass login, use [Embedded feedback](/help/24-embedded-feedback)
  instead, which supports both signed-in teammates and external reviewers by
  email link.
- **Screenshots** are not captured for pins created this way (unlike the
  embed widget, which can capture one when the browser allows it) — you are
  already looking at the artifact, so a screenshot of it is redundant.
