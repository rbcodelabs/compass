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

For guided usability tests, the participant first chooses Chat or Voice. On desktop the live product appears beside the neutral moderator; on smaller screens it uses a constrained stacked layout. An **Open product** action is always available when a site blocks embedding. The moderator presents one task at a time, asks the participant to think aloud, and probes expectations without identifying controls or rescuing them.

![Guided participant experience on desktop](/screenshots/docs/guided-participant-desktop.png)

![Guided participant experience on mobile](/screenshots/docs/guided-participant-mobile.png)

Participants can share a screenshot or PDF as research evidence. Files are signature-checked, bounded, stored privately, and delivered only through an authorized session or workspace-member request. If private storage fails partway through an upload, Compass records cleanup in a research-owned retry queue without exposing the private pathname. Chat sends bounded file bytes to the isolated interviewer. Voice can share an image directly with the realtime moderator; PDFs are represented only by a safe, untrusted description. Raw voice audio is not retained.

Compass saves each finalized participant and interviewer turn as the session progresses. If a participant reloads or briefly closes the tab, the same browser can safely resume its own in-progress Chat or Voice session. Finishing removes that browser's resume credential. Completed and abandoned sessions, their canonical transcripts, modality, and authorized attachments remain attached to the study and its workspace for member review.

Public sessions have bounded message size, duration, turn count, attachment size/count/rate, and request rate. A participant link grants no access to workspace feedback, documents, opportunities, or other internal tools. Both Chat and Voice use server-authored prompts and models with no Compass tools or workspace credentials.

## Inbox

The Capture **Inbox** opens the existing feedback workflow for ideas and bugs. Customer portal submissions, votes, attachments, opportunity links, and roadmap actions continue to work as before. While research studies remain behind the rollout gate, navigation continues to show **Feedback** and the existing `/feedback` route remains unchanged.

## Privacy and review

Participant pages explain that responses are shared with the research team. Research links grant access only to their associated study, and a separate session secret prevents one participant from resuming another participant's interview. Workspace membership is required to view study details and transcripts. AI-generated findings will require review before they become Compass evidence or affect discovery objects.
