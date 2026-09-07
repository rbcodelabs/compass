---
title: "Capture"
description: "Collect feedback and run customer research inside Compass"
icon: "MessageSquare"
order: 16
section: "Workspace"
---

# Capture

Capture is the starting point for customer feedback, ideas, and research. It keeps raw input connected to the opportunities and decisions it informs.

## Studies

Open **Capture** and choose **New study** to create either a customer interview or a guided usability test. Customer interviews use open-ended discussion questions. Guided usability tests add an HTTPS product URL, a 10, 15, 20, or 30 minute target, and five to eight editable participant tasks. Compass can draft realistic tasks from the research goal and product URL; review, edit, add, or remove them before creating the study.

Choose a target duration for either study type. Compass can generate an editable set of 5–8 neutral discussion questions for a customer interview or realistic tasks for a usability test. Review and edit every generated item before activating the study.

After creating the study, Compass shows a secure participant link. Share that link with participants so they can complete the interview without a Compass account. Links expire after 30 days and Compass stores only a secure hash, so save the displayed link when it is created. You can rotate the link, which immediately revokes the previous link, or revoke all active links without creating a replacement.

Study settings remain editable until the first participant session starts. After that point Compass locks the research goal, study type, duration, product URL, and guide so every session uses the same protocol; the study name can still be changed. Close a study to revoke its links while keeping it available for review, reactivate it to issue a fresh participant link, or archive it to remove it from the normal Capture list while retaining its research record.

![Guided usability study creation](/screenshots/docs/guided-study-create.png)

Participants use Chat by default. The legacy browser-authoritative Voice path is unavailable in production, even when `COMPASS_RESEARCH_AUTHORITATIVE_VOICE_ENABLED=1`; that flag is reserved for the replacement authoritative transport. The legacy path can run only in the non-production functional E2E harness when the flag and `E2E_FUNCTIONAL=1` are both set. Customer-interview voice additionally requires `COMPASS_RESEARCH_DISCOVERY_VOICE_ENABLED=1` in production. Chat remains available regardless of voice configuration.

For guided usability tests, the live product appears beside the neutral moderator on desktop and uses a constrained stacked layout on smaller screens. An **Open product** action is always available when a site blocks embedding. The moderator presents one task at a time, asks the participant to think aloud, and probes expectations without identifying controls or rescuing them.

![Guided participant experience on desktop](/screenshots/docs/guided-participant-desktop.png)

![Guided participant experience on mobile](/screenshots/docs/guided-participant-mobile.png)

Participants can share a screenshot or PDF as research evidence. Files are signature-checked, bounded, stored privately, and delivered only through an authorized session or workspace-member request. If private storage fails partway through an upload, Compass records cleanup in a research-owned retry queue without exposing the private pathname. Chat sends bounded file bytes to the isolated interviewer. Voice can share an image directly with the realtime moderator; PDFs are represented only by a safe, untrusted description. Raw voice audio is not retained.

Compass saves each finalized participant and interviewer turn as the session progresses. If a participant reloads or briefly closes the tab, the same browser can safely resume its own in-progress Chat or Voice session. Finishing removes that browser's resume credential. Completed and abandoned sessions, their canonical transcripts, modality, and authorized attachments remain attached to the study and its workspace for member review.

Public sessions have bounded message size, duration, turn count, attachment size/count/rate, and request rate. A participant link grants no access to workspace feedback, documents, opportunities, or other internal tools. Both Chat and Voice use server-authored prompts and models with no Compass tools or workspace credentials.

## Research results

Open a study to review session status, dates, saved-turn counts, summaries and transcripts. **View full interview and attachments** opens a paginated transcript; evidence links jump to the page containing the referenced turn. Study lists, sessions, transcript turns, attachments and synthesis history are paginated, so older research remains accessible. **View archived studies** opens retained archived records.

After a session is durably completed, Compass attempts an interview summary in the background. An analysis failure does not undo completion or lose the transcript. Members can choose **Generate summary** to retry, or **Regenerate summary** to replace it. **Check guide coverage** reports whether each discussion question or task was meaningfully addressed, with links to saved participant evidence.

**Generate synthesis** analyzes all saved completed sessions in the study and produces an executive summary, themes and verbatim supporting quotes, surprises, repeated patterns, jobs to be done, and recommendations. **Regenerate synthesis** creates a new snapshot; previous snapshots remain inspectable. A snapshot is marked when newly completed sessions or a changed guide make its source set stale. Matching session analysis can be reused until explicit regeneration is requested.

Analysis uses a separate tool-free runtime with no Compass workspace credentials. Quotes and evidence IDs must match saved participant turns; interpretation still needs researcher review. Voice source is unverified in this view; browser voice is participant-reported evidence, not independently authenticated provider records. Analysis does not inspect attachment bytes or infer their contents from filenames. No audio recording is created.

Snapshot freshness assumes completed transcripts remain immutable, as enforced by the participant completion flow. A future transcript-editing feature must invalidate analysis fingerprints and freshness metadata. Pattern, job and recommendation evidence links resolve only within the study the researcher is authorized to view.

Analysis is bounded to 500 completed sessions, 2,000 turns per session and 500,000 serialized input characters per request. If a study exceeds a limit, Compass returns an explicit error instead of silently omitting interviews. Transcript browsing is independent of those analysis limits. Analysis has a 150-second operation deadline, leaving time for bounded sandbox cleanup before a claim can be reclaimed after three minutes. Expired results cannot replace the current claim; failures leave prior successful results intact.

![Research results on desktop](/screenshots/docs/capture-results-desktop.png)

![Research results on mobile](/screenshots/docs/capture-results-mobile.png)

## Inbox

The Capture **Inbox** opens the existing feedback workflow for ideas and bugs. Customer portal submissions, votes, attachments, opportunity links, and roadmap actions continue to work as before. While research studies remain behind the rollout gate, navigation continues to show **Feedback** and the existing `/feedback` route remains unchanged.

## Privacy and review

Participant pages explain that responses are shared with the research team. Research links grant access only to their associated study, and a separate session secret prevents one participant from resuming another participant's interview. Workspace membership is required to view study details and transcripts. AI-generated findings will require review before they become Compass evidence or affect discovery objects.
