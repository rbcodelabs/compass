# ADR 0016 — Workspace Updates and Explicit Catch-up State

**Moved to Compass Docs — this file is a pointer stub.**
**Decided:** Capture product mutations as append-only workspace events with a
per-workspace revision counter, and give returning members an explicit
Mark caught up / Undo feed built on that ordering. (Status: Accepted for MVP
implementation; production rollout requires separate authority)
**Authoritative record:** <https://compass.rbcodelabs.com/rbcodelabs/compass/docs/a6c1a3df-67a6-4775-b34b-c6ecab3bbea9>
**Number collision:** this repo already has an unrelated ADR 0016 (Membership-Scoped
Read Resolver for Cross-Workspace Views). Neither is renumbered — check the subject.

> **Do not add ADR files to this directory.** New architecture decisions are
> created as a Compass Doc under [Architecture Decisions](https://compass.rbcodelabs.com/rbcodelabs/compass/docs/57218788-1db1-4148-b954-b98fb7055c62) and
> routed for approval with `request_decision` (`subjectType: "DOC"`).
