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

Press **View full screen** to open the artifact edge to edge in its own page,
with the same picker and pins. The controls float over the artifact in a pill at
the bottom: previous/next and slide count for decks, **Feedback** (pick an
element), **Comments** (comment on the whole slide), **All slides** (a grid to
jump to any slide), a browser full-screen toggle, and **Back** to return to the
docked view.

## Slide decks

An uploaded HTML Artifact can be shown as a **slide deck**. To do that, tick
**This is a slide deck** when you upload it, or **Show as a slide deck** in
the artifact's Details later. MCP clients can pass `kind: "SLIDE_DECK"` to
`create_artifact` or `update_artifact`. The file itself is unchanged, and
switching back to a plain document is just as reversible.

A deck shows one slide at a time. To move between slides, use the arrows above
the preview, the **←/→** keys or **Page Up/Page Down**. The slide number and
title appear between the arrows. Compass finds the slides in your HTML in this
order, using the first pattern that yields more than one slide:

1. Reveal.js (`.reveal .slides > section`)
2. Elements with the `slide` class
3. `id="slide-N"` or `data-slide` elements
4. `<section>` children of `<body>`, or of a single wrapper `<div>`
5. Content separated by `<hr>`

A slide authored at a fixed size (say a 1280×720 canvas) is scaled to fill
the preview and centred, letterboxed to keep its proportions, and it re-fits
when the window or full-screen state changes. Slides that already fill the
width, are smaller than 480×270, or are much taller than they are wide are
shown at their natural size.

Name a slide by adding `data-slide-title="…"` to its element. An HTML file
that splits into more than 200 slides is shown as a single document instead
of being truncated.

There are two ways to leave feedback on a deck:

- **Leave feedback** pins a comment to an element on the current slide, as
  above. The pin appears only while that slide is on screen.
- **Comment on slide** leaves a comment about the whole slide, with no
  element pinned. These comments are listed under the preview while the slide
  is showing.

Both kinds of comment record the slide they were left on, and they also
appear in the **Comments** panel like any other comment. **View full screen**
and **Back to artifact** keep you on the current slide, as does a link with
`?slide=N` (counting from 1).

## What this does not cover

- **External reviewers and portal visitors** cannot use this picker — it
  authenticates through your normal Compass session. To collect feedback from
  people without a Compass login, use [Embedded feedback](/help/24-embedded-feedback)
  instead, which supports both signed-in teammates and external reviewers by
  email link.
- **Screenshots** are not captured for pins created this way (unlike the
  embed widget, which can capture one when the browser allows it) — you are
  already looking at the artifact, so a screenshot of it is redundant.
