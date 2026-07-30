---
title: "Docs"
description: "Create rich internal documentation with inline screenshots"
icon: "BookOpen"
order: 6
section: "Core Features"
---

# Docs

The Docs section provides a hierarchical rich-text editor for internal team documentation. Use it for PRDs, research notes, experiment write-ups, onboarding guides, or anything else your team writes together.

![Docs editor](/screenshots/docs/docs-editor.png)

> 📸 Screenshot: run `pnpm docs:screenshots` with a `DOCS_SESSION_FILE` to capture this image.

## Page Hierarchy

Documents are organised as a tree. Each page can have child pages nested beneath it. The left sidebar in the Docs section shows your full tree. Click any page title to open it, or click the **+** icon next to a parent page to create a child page.

Pages can be dragged to reorder them within their level of the hierarchy.

## The Editor

Docs uses a Tiptap-powered rich-text editor. Supported formatting includes:

- **Headings** — H1, H2, H3 via the toolbar or by typing `#`, `##`, `###` at the start of a line
- **Lists** — Bulleted (`-` or `*`) and numbered (`1.`)
- **Bold / Italic / Underline** — Via toolbar buttons or `Cmd+B`, `Cmd+I`, `Cmd+U`
- **Code blocks** — Inline code with backticks, fenced code blocks with triple backticks
- **Links** — Select text and click the link button to add a URL
- **Horizontal rules** — Type `---` on a blank line
- **Blockquotes** — Start a line with `>`

## Inserting Screenshots

Click the **image icon** in the toolbar to upload a screenshot. You can also paste an image from the clipboard directly into the editor — Compass will upload it automatically and embed it inline.

Images are stored in Vercel Blob storage and served via a CDN. They are always private — only workspace members can view them.

## Page Properties

Above the editor, a collapsible **Properties** panel lets you attach arbitrary key/value metadata to a page — similar to frontmatter. Click **Properties** to expand it, then **+ Add property** to create a new entry.

- String-array values render as removable tag chips — type a value and press Enter or `,` to add another.
- Any property whose key contains `date`, `created`, `updated`, or `modified` (or ends in `at`), or whose value already looks like a date (`YYYY-MM-DD`), gets a date picker input instead of a plain text field.
- Click a property's key to rename it inline.

Like the rest of the editor, properties autosave about 800ms after you stop typing — there's no manual save button.

## Auto-save

The editor auto-saves your changes every few seconds. There is no manual save button. The last saved timestamp appears at the top of the editor. You can safely close the tab and return — your work is preserved.

## Positioning & Messaging Briefs

A Positioning & Messaging Brief is a Doc linked one-to-one to a Roadmap Item, used to nail down the story before a launch: problem statement, target audience, core message, proof points, and competitive differentiation. Create one via the MCP API's create_doc tool with docType set to GTM_POSITIONING_BRIEF and roadmapItemId set to the roadmap item it belongs to; if you do not pass explicit content, Compass fills in a five-section starter template you can edit like any other doc. Attempting to link a second brief to the same roadmap item is rejected, since the relationship is one-to-one.

There is no dedicated UI for briefs yet; they appear in the regular Docs tree like any other page, and get_doc surfaces the linked roadmap item and doc type so an agent can discover the linkage.

## Page Titles

Click the title area at the top of the editor to rename a page. Titles are saved immediately on blur.
