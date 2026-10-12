---
title: "Background agent runs"
description: "The in-app agent keeps working after you close the tab, and you can pick the reply up later"
icon: "CloudCog"
order: 27
section: "Core Features"
---

# Background agent runs

When you send a message to the Compass in-app agent, the work happens on the
server, not in your browser. You can close the tab, switch conversations, put the
laptop to sleep, or lose your connection — the agent keeps going, and the reply is
waiting in the conversation when you come back.

This also means a turn is no longer limited to what fits in the few minutes a
browser will hold a request open. Ask for something substantial.

## While a run is going

The conversation shows the agent's progress as it happens: the text it is writing
and the Compass tools it is using, in order.

Underneath the transcript you will see a note — *This runs on the server, you can
close this tab and pick the reply up here later.* That note is the signal that the
turn is detached. While it is showing:

- The **Send** button becomes a **Stop** button. Sending another message has to
  wait: a conversation runs one turn at a time.
- Closing the tab, navigating away, or reloading does not cancel anything.
- You can watch the same run from more than one place at once — a second tab, or
  your phone — and both views show the same transcript.

## Coming back to a run

Reopen the conversation and Compass reattaches automatically. If the run is still
going, the live view resumes, including everything that happened while you were
away. If it finished, the reply and the tool steps it took are simply part of the
conversation.

Nothing is lost in between: the agent records each step as it happens rather than
only at the end, so a run you never watched has the same transcript as one you
watched throughout.

## Stopping a run

**Stop** ends the run on the server and releases its resources. The conversation
records that it was canceled.

Stopping is not an undo. Anything the agent already did — a task it created, a
comment it added — stays done. Check the conversation's tool steps to see what
that was, and look at [Agent activity](/help/19-agents#activity) for the full
record.

If the agent finishes in the moment between your clicking Stop and the request
arriving, the result is kept rather than thrown away. The conversation shows what
actually happened.

## Time limits, and runs that end on their own

Every run gets a time budget — **20 minutes** by default, and never more than
**one hour**. A run that reaches its budget stops, and the conversation says so.
Whatever the agent produced before that point is preserved.

A run can also end on its own without a reply, if the machine it was running on
fails. Compass notices within about a minute and marks the run interrupted rather
than leaving the conversation looking busy forever. Your transcript up to that
point is kept, and you can send the message again.

Daily usage limits are unchanged, and they apply when a run *starts*. A long run
does not consume more of your daily allowance than a short one.

## Deployment

Administrators must apply and verify migration `069_background_agent_runs`
before this behavior is available. Until it is applied, the agent keeps working
exactly as it did before — turns run inside the browser request, with the
previous few-minute ceiling — so deploying ahead of the migration is safe and
changes nothing for users.

Two settings matter for a deployed environment:

- **`CRON_SECRET`** must be set. Compass runs a once-a-minute scheduled job
  (`/api/cron/agent-run-sweeper`) that ends runs which have exceeded their budget
  or whose sandbox has stopped reporting. Without the secret the job refuses to
  run, and interrupted runs stay visible as in-progress until it is configured.
- The scheduled job is declared in `vercel.json`. A deployment that drops that
  file keeps working, but nothing cleans up after a failed run.
