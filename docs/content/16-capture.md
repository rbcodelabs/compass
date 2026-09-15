---
title: "Capture"
description: "Collect feedback and run customer research inside Compass"
icon: "MessageSquare"
order: 16
section: "Workspace"
---

# Capture

## Browser voice availability

Browser-managed voice supports discovery interviews and guided usability tests
when separately enabled by the operator after release verification. It remains
off by default. Microphone audio connects directly to the realtime provider;
Compass does not record raw audio. Saved voice transcripts are labeled
participant-submitted evidence, not independently authenticated provider records.

Keep the page open until saving finishes. A failed save stops the microphone and
offers **Retry saving transcript**; do not close the page with unsaved speech.
**Finish session** stops capture and waits for final captions and acknowledged
saves before marking the interview complete. Reconnecting uses saved transcript
context. There are five connection attempts per session, including ambiguous
connection failures. Local microphone closure does not guarantee provider-side
termination or a hard spending limit.

![Discovery voice with a live caption](/screenshots/docs/browser-voice-customer_interview-desktop.png)

![Guided voice beside the product](/screenshots/docs/browser-voice-usability_test-desktop.png)

Mobile examples: [discovery voice](/screenshots/docs/browser-voice-customer_interview-mobile.png) and [guided voice](/screenshots/docs/browser-voice-usability_test-mobile.png).

Capture is the starting point for customer feedback, ideas, and research. It keeps raw input connected to the opportunities and decisions it informs.

## Refinement

Workspace members can start **Refine** from an opportunity, solution,
assumption, or experiment, or choose **PM interview** in Capture and select an
existing item. Compass uses only that item, its parent chain, linked outcome, and
directly linked feedback or evidence. It discloses when bounded context was omitted.

The 15-minute interview is voice-first with text available. Voice uses the same
Realtime connection, finalized-turn persistence, reconnect limits, and lease
fencing as participant research, but PM interviews require workspace
authentication and never expose a participant link. **Continue in text** first
saves finalized captions and releases the voice lease; the interview cannot switch
back to voice. Raw audio is not retained.

**Finish and update item** saves the transcript and opens a linked core-agent
conversation. Finish gives the agent permission to update the interviewed item's
descriptive fields immediately—there is no separate proposal approval step.
The conversation shows progress and the saved changes, including before/after
values and a link to the item. A completed turn with no saved edits says so.
Other workspace members can read interview history; the agent conversation is
private to the initiating PM. Concurrent field edits are checked before writing.
Experiment protocols can only be updated while the experiment is **Designing**.

![Saved PM interview changes in the core agent conversation, using fictional sample data](/screenshots/docs/pm-interview-agent-desktop.png)

[View the saved changes on mobile](/screenshots/docs/pm-interview-agent-mobile.png).

If processing stops, reopen the same interview's agent conversation and use
**Retry update**. Do not repeat the interview. Reloading does not start duplicate
processing, and a committed update remains visible even if the stream disconnects.
Older saved proposals and application receipts remain available in history.

PM statements are internal interpretations, not customer evidence. PM interviews
do not create evidence, change confidence or lifecycle state, alter relationships,
or write experiment results. Suggested assumptions and experiments remain written
next steps in this version.

![PM interview item picker on desktop](/screenshots/docs/pm-interview-picker-desktop.png)

![PM interview item picker on mobile](/screenshots/docs/pm-interview-picker-mobile.png)

## Studies

Open **Capture** and choose **New study** to create either a customer interview or a guided usability test. Customer interviews use open-ended discussion questions. Guided usability tests add an HTTPS product URL, a 10, 15, 20, or 30 minute target, and five to eight editable participant tasks. Compass can draft realistic tasks from the research goal and product URL; review, edit, add, or remove them before creating the study.

Choose a target duration for either study type. Compass can generate an editable set of 5–8 neutral discussion questions for a customer interview or realistic tasks for a usability test. Review and edit every generated item before activating the study.

After creating the study, Compass shows a secure participant link. Share that link with participants so they can complete the interview without a Compass account. Links expire after 30 days and Compass stores only a secure hash, so save the displayed link when it is created. You can rotate the link, which immediately revokes the previous link, or revoke all active links without creating a replacement.

Study settings remain editable until the first participant session starts. After that point Compass locks the research goal, study type, duration, product URL, and guide so every session uses the same protocol; the study name can still be changed. Close a study to revoke its links while keeping it available for review, reactivate it to issue a fresh participant link, or archive it to remove it from the normal Capture list while retaining its research record.

![Guided usability study creation](/screenshots/docs/guided-study-create.png)

Participants use Chat by default. The separate `COMPASS_RESEARCH_BROWSER_VOICE_ENABLED=1` gate enables browser voice for both study types after its migration and release checks. The authoritative voice flag does not enable this path. A non-production functional harness can exercise synthetic voice without contacting a provider. Chat remains available regardless of voice configuration.

Voice conversations in both study types give participants time to think. Compass uses the meaning of an answer to estimate when a thought is finished, with a less eager response setting to reduce interruptions during pauses. Replies still start automatically, and participants can interrupt the moderator by speaking. The wait varies with the answer; it is not a fixed delay or a guarantee against every interruption.

**Finish session** immediately mutes your microphone, then briefly waits for any final caption to be saved before completing. If the caption cannot finish within ten seconds, Compass stops the connection and reports that the session was not completed.

For guided usability tests, the live product appears beside the neutral moderator on desktop and uses a constrained stacked layout on smaller screens. An **Open product** action is always available when a site blocks embedding. The moderator presents one task at a time, asks the participant to think aloud, and probes expectations without identifying controls or rescuing them.

The product pane and external fallback remain available when voice is disabled.
In chat, use **Enter** to send or **Shift+Enter** for a new line. Interviewer text
appears as a clearly labeled draft while it is generated; it becomes part of the
saved transcript only after Compass confirms the final reply. If the connection
fails, **Try again** safely reuses the same request. Reloading restores saved
turns and lets you retry an unconfirmed request without duplicating the answer.
If the interviewer service cannot complete a reply, choose **Try again**. A
service failure does not necessarily mean your connection is broken. If it
continues, or the interviewer is unavailable, contact the research team; do not
start a new interview to recover the same answer.

An unconfirmed answer is temporarily kept in this browser for recovery, for up
to the two-hour session window. An open page clears it on expiry; a closed
browser clears expired recovery data when reopened. Finish becomes available
after any upload and pending reply are resolved.

![Guided participant chat on desktop](/screenshots/docs/research-guided-chat-desktop.png)

![Guided participant chat on mobile](/screenshots/docs/research-guided-chat-mobile.png)

Participants can share images or PDFs as research evidence. Files are signature-checked, bounded, stored privately, and delivered only through an authorized session or workspace-member request. Signature recognition is not a guarantee that a file will decode successfully. If private storage fails partway through an upload, Compass records cleanup in a research-owned retry queue without exposing the private pathname. Raw voice audio is not retained.

Choose or drag in a PNG, JPEG, WebP, GIF, HEIC image or PDF (up to 10 MiB per file). You can
send evidence without typing an answer, and remove pending evidence before
sending. Supported browser images show previews; when decoding fails, the original
download remains available. HEIC files use an explicit download fallback, not a
converted preview. PDFs open through a private, authorized link.
The browser must identify the file's MIME type. If it supplies no type, Compass
rejects the upload with guidance to try another browser or a supported alternative;
it never trusts a `.heic` filename alone.
Saved evidence remains visible with its answer after a reload. Temporary preview
URLs are released when the preview closes; storage paths and session credentials
are never placed in download URLs.

| Evidence format | Chat moderator | Voice moderator |
| --- | --- | --- |
| PNG, JPEG, WebP | Image contents | Image contents after the evidence is saved |
| GIF | First frame only, never animation | Original preserved; contents not sent |
| HEIC | Original preserved; contents not sent | Original preserved; contents not sent |
| PDF | Document contents | Original preserved; contents not sent |

The moderator is told when contents were not supplied and must not infer them
from the filename. Researchers can retrieve the original privately from the
session detail view, including after participant reload. There is no conversion
service. GIF first-frame handling follows [Claude's documented vision support](https://platform.claude.com/docs/en/build-with-claude/vision).
Although [Realtime supports image inputs](https://developers.openai.com/api/docs/guides/realtime-conversations),
Compass does not assume GIF animation or HEIC support and preserves those files
without sending their contents to voice.

![Saved GIF and HEIC evidence with honest download fallbacks](/screenshots/docs/research-attachment-formats-desktop.png)

![Private attachment downloads on mobile](/screenshots/docs/research-attachment-formats-mobile.png)

Compass saves each finalized participant and interviewer turn as the session progresses. If a participant reloads or briefly closes the tab, the same browser can safely resume its own in-progress Chat or Voice session. Finishing removes that browser's resume credential. Completed and abandoned sessions, their canonical transcripts, modality, and authorized attachments remain attached to the study and its workspace for member review.

Public sessions have bounded message size, duration, turn count, attachment size/count/rate, and request rate. A participant link grants no access to workspace feedback, documents, opportunities, or other internal tools. Both Chat and Voice use server-authored prompts and models with no Compass tools or workspace credentials.

## Research results

Open a study to review session status, dates, saved-turn counts, summaries and transcripts. **View full interview and attachments** opens a paginated transcript; evidence links jump to the page containing the referenced turn. Study lists, sessions, transcript turns, attachments and synthesis history are paginated, so older research remains accessible. **View archived studies** opens retained archived records.

After a session is durably completed, Compass attempts an interview summary in the background. An analysis failure does not undo completion or lose the transcript. Members can choose **Generate summary** to retry, or **Regenerate summary** to replace it. **Check guide coverage** reports whether each discussion question or task was meaningfully addressed, with links to saved participant evidence.

**Generate synthesis** opens a Compass agent conversation linked to the study, in the same way that finishing a PM interview does. The agent reads every saved completed session through gated, study-scoped tools, applies the synthesis methodology from your workspace's installed capability packs, and writes back an executive summary, themes and verbatim supporting quotes, surprises, repeated patterns, jobs to be done, and recommendations. **Regenerate synthesis** starts another conversation and creates a new snapshot; previous snapshots remain inspectable on the study page. A snapshot is marked when newly completed sessions or a changed guide make its source set stale. Only one generation runs at a time per study, so a duplicate request is rejected rather than producing a second snapshot. A study with no completed interviews cannot be synthesized.

That conversation is deliberately restricted: it may read this one study, its sessions and its synthesis history, and it may store a synthesis for this study. It cannot read another study, and it cannot create or change opportunities, solutions, assumptions, experiments, evidence, feedback, roadmap items or tasks. Promoting a finding into your discovery work stays a separate, human-directed step that you take yourself in the conversation afterwards.

Compass validates the result before storing it: quotes must be exact verbatim substrings of saved participant turns and evidence IDs must reference real saved turns, checked server-side against the stored transcripts rather than taken on trust. A synthesis containing a fabricated quote or an unknown turn is rejected and nothing is saved. Per-session **Generate summary** and **Check guide coverage** continue to run as bounded background analysis rather than a conversation. Interpretation still needs researcher review. Voice source is unverified in this view; browser voice is participant-reported evidence, not independently authenticated provider records. Analysis does not inspect attachment bytes or infer their contents from filenames. No audio recording is created.

Snapshot freshness assumes completed transcripts remain immutable, as enforced by the participant completion flow. A future transcript-editing feature must invalidate analysis fingerprints and freshness metadata. Pattern, job and recommendation evidence links resolve only within the study the researcher is authorized to view.

Analysis is bounded to 500 completed sessions and 2,000 turns per session; per-session summaries and coverage are additionally bounded to 500,000 serialized input characters per request, and a stored synthesis document to 100,000 characters. If a study exceeds a limit, Compass returns an explicit error instead of silently omitting interviews. Transcript browsing is independent of those analysis limits. Analysis has a 150-second operation deadline, leaving time for bounded sandbox cleanup before a claim can be reclaimed after three minutes. Expired results cannot replace the current claim; failures leave prior successful results intact.

![Research results on desktop](/screenshots/docs/capture-results-desktop.png)

![Research results on mobile](/screenshots/docs/capture-results-mobile.png)

## Inbox

Workspace agents can create and manage the same research studies through the [MCP API](/help/09-mcp-api), including editable guide generation, bounded study listing, settings, lifecycle and explicit link controls. The tools preserve the UI’s protocol lock and hashed participant-link behavior; they do not expose participant transcripts or enable voice. Existing participant research credentials cannot call these tools.

The Capture **Inbox** opens the existing feedback workflow for ideas and bugs. Customer portal submissions, votes, attachments, opportunity links, and roadmap actions continue to work as before. While research studies remain behind the rollout gate, navigation continues to show **Feedback** and the existing `/feedback` route remains unchanged.

## Privacy and review

Participant pages explain that responses are shared with the research team. Research links grant access only to their associated study, and a separate session secret prevents one participant from resuming another participant's interview. Workspace membership is required to view study details and transcripts. AI-generated findings will require review before they become Compass evidence or affect discovery objects.
