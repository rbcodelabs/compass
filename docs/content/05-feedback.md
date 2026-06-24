---
title: "Feedback Portal"
description: "Collect and triage customer feedback publicly with voting"
icon: "MessageSquare"
order: 5
section: "Core Features"
---

# Feedback Portal

The Feedback Portal gives your customers a public page to submit feature requests and bug reports, and to vote on what matters most to them. It connects directly to your internal Discovery workflow so feedback automatically informs opportunity prioritisation.

![Feedback portal](/screenshots/docs/feedback.png)

> 📸 Screenshot: run `pnpm docs:screenshots` with a `DOCS_SESSION_FILE` to capture this image.

## Enabling the Portal

The feedback portal is off by default. To enable it, go to **Settings → Portal** in your workspace. Toggle on:

- **Public Feedback Portal** — Enables the public submission and voting page
- **Public Roadmap** — Enables the public roadmap view showing your Now / Next / Later items

Once enabled, your portal URLs are:

- **Feedback:** `/portal/[org]/[workspace]/feedback`
- **Public Roadmap:** `/portal/[org]/[workspace]/roadmap`

Share these links in your product, in onboarding emails, or in your documentation. No login is required for visitors to submit or vote.

## How Visitors Submit Feedback

Visitors to your feedback portal see a list of existing submissions sorted by vote count. They can:

- **Submit new feedback** by clicking **Share Feedback** — they provide a title and optional description
- **Vote on existing feedback** by clicking the upvote button on any submission. Each visitor can vote once per item (tracked by IP and session)

Submissions automatically appear in your internal feedback triage view immediately.

## Triaging Feedback Internally

Inside Compass, the **Feedback** section shows all submitted feedback across your workspace. The internal view includes:

- Vote count and submission date
- The submitter's description
- A **Link to Opportunity** button that connects the feedback item to an existing opportunity in Discovery

Linking feedback to opportunities is how you turn raw customer voice into prioritised discovery work. An opportunity with ten linked feedback items has much stronger justification for investment than one based on a single interview.

## Keeping the Portal Fresh

The public feedback portal shows all submitted items, so quality matters. Internal team members can delete spam or off-topic submissions. For legitimate submissions that have been addressed via a shipped feature, you can mark them as closed — they'll still appear in the history but are visually distinguished from open items.
