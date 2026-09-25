# Publicly accessible, element-anchored artifact comments

**Status:** Proposed — RFC, seeking maintainer agreement on shape before any implementation.
**Author:** External contributor
**Date:** 2026-09-25
**Verified against:** `upstream/main` @ `e534bf81`, re-checked at `483245a7`
**Revision:** sixth draft. Every factual claim re-checked against source. The
corrections made to each previous draft are listed in the appendix rather than
applied silently — [third pass](#what-the-third-pass-found),
[fourth pass](#what-the-fourth-pass-found),
[fifth pass](#what-the-fifth-pass-found),
[sixth pass](#what-the-sixth-pass-found) — including the errors each pass's own
corrections introduced into the next draft.

The sixth pass was the first to re-verify against a *moved* `main`: fifteen
commits landed between the fifth pass and this one, and two of this document's
claims were falsified by that movement rather than by any editing — see
[the sixth pass](#what-the-sixth-pass-found). Line numbers in this document are
therefore a perishable good. Where a citation names a symbol as well as a line,
trust the symbol.

`main` moved once more while this draft was being finalised — `e534bf81` →
`483245a7` (#297, the docked feedback composer). That commit touches 33 files and
**none** of the 46 files this document cites, so every citation below was
re-confirmed to still resolve at `483245a7`; migration `062` is also still free.
Stating both hashes is deliberate: the first is where the claims were read, the
second is where they were last confirmed.

---

## Summary

Compass just shipped Artifact Comments (#275): a whole-artifact discussion that
travels with the artifact across revisions. This RFC proposes the two things
that turn that into prototype review:

1. **An optional anchor** — a comment may additionally record *which element on
   which page* it refers to, so a reviewer can point at the broken button rather
   than describe it.
2. **A public write path** — one `<script>` tag on a prototype (a v0 build, a
   staging URL, a design deploy) lets someone **with no Compass account** leave
   that comment from the prototype itself.

The second item is the point. Compass's artifact comments today are for people
who are already signed in and already looking at the artifact in Compass.
Prototype feedback comes from stakeholders, customers, and colleagues who will
never log in to Compass and are looking at the *prototype*, not the tool.

Both additions are smaller than they sound, because Compass already has the
hard parts. An anchored comment is a `Comment` with a 1:1 anchor extension —
the **third** instance of a pattern already used twice (`DocCommentAnchor`,
`SolutionPlanProposal`), with the identity extension making a fourth. Public
access is already a first-class, shipped,
per-workspace-configurable Compass mode; it is simply wired to `FeedbackItem`
today and not to `Comment`.

Derived from an internally-deployed commenting service, referred to here as **the
source service**. This RFC ports its *ideas and hard-won failure modes*, not its
code; it lives in a private repository and is therefore described rather than cited
(see [provenance](#appendix--provenance)).

> **This supersedes an earlier draft of this document** that modelled the
> capture record as a `FeedbackItem` and rejected the `Comment` route. #275
> landed while that draft was open and changed the answer. The reversal is
> argued explicitly under [Alternatives](#alternatives-considered), option A,
> rather than quietly rewritten.

## Motivation

Compass's model is outcome → opportunity → solution → experiment, with evidence
attached. The weakest link is getting evidence **back from a prototype**. A team
ships a prototype to validate a solution's riskiest assumption and the feedback
arrives as Slack screenshots, a spreadsheet, or nothing.

Two properties have to hold at once, and existing tools each give up one:

- **Anyone can comment.** Not "anyone with a seat" — anyone with the link. The
  moment feedback requires a *workspace membership*, the people whose reaction you
  actually need stop giving it. This is the entire reason a standalone commenting
  tool gets adopted. Note the load-bearing word is **membership**, not identity:
  the source service does require a sign-in to post, and still counts as publicly
  accessible because no seat, invitation, or admin action is involved. How far
  down that spectrum Compass should sit is [Open question 4](#open-questions-for-maintainers).
- **The comment is connected.** Standalone tools solve capture and then strand
  the data. The source service stores comments that are structurally orphans:
  its schema records the page URL and the CSS selector and has **no column that
  could express** which solution the prototype was testing or which opportunity
  it traced to.

Compass is the only place both can be true, because `ArtifactLink` already links
an artifact to a `SOLUTION` and the `promote_*` family already carries a record
onward into the tree. A comment on a button becomes traceable to the outcome it
serves — **and that is the whole argument for building this inside Compass
rather than integrating a third-party tool by webhook.**

Public accessibility is therefore not a concession this design makes to
convenience. It is the requirement, and everything below is arranged around
keeping it cheap.

## Non-goals

- **Not** a general-purpose website annotation tool. Scope is prototypes an
  `Artifact` points at.
- **Not** a change to how existing artifact comments behave. The anchor is
  additive and nullable; a comment without one is exactly what #275 shipped.
- **Not** a new triage lifecycle. Anchored comments are discussion. Anything
  that deserves triage is **promoted** to a `FeedbackItem` — see
  [Promotion](#promotion--where-triage-actually-begins).
- **Not** a new comment target type. `ARTIFACT` is already in
  `COMMENT_TARGET_TYPES`; the registry does not change.

One boundary is this RFC's **recommended default, not a settled non-goal** — it
is Open question 3, and a maintainer answering it differently is answering an
open question:

- Phase 1 **as proposed** excludes hosting uploaded prototype HTML. Serving
  arbitrary uploaded HTML from a Compass origin is a large security surface.

---

## What already exists (the reuse case)

Every row was verified against `upstream/main` @ `e534bf81`. Schema rows cite field
names rather than line numbers: `prisma/schema.prisma` gained 125 lines between the
fifth and sixth review passes, and every line-number citation into it went stale.

| Need | Already in Compass | Where |
| --- | --- | --- |
| Comment on an artifact | `Comment` + `targetType: "ARTIFACT"` — **already registered** | `lib/comments.ts` |
| Thread UI for it | `<Discussion targetType="ARTIFACT" targetId={artifact.id} render={…}>` — `Discussion` is the **outer** component and passes its rendered thread *into* a `render` prop | `components/comments/discussion.tsx`, `components/docs/artifact-detail.tsx:80-87` |
| Side panel for it | `DocPanelShell panelId="artifactComments"`, supplied as `Discussion`'s `render` prop — `artifactComments` is **already** a `PanelId` | `lib/panel-pin.ts` |
| 1:1 anchor extension keyed on `Comment.id` | `DocCommentAnchor`, `SolutionPlanProposal` — **two** existing instances | `prisma/schema.prisma` |
| Resilient re-anchoring by content, not coordinates | `DocCommentAnchor` (`anchorText`/`anchorPrefix`/`anchorSuffix`) | `prisma/schema.prisma` |
| One-level-deep threading | Enforced: `if (parent.parentId) throw new Error("Comment threads are only one level deep.")` | `lib/comments.ts` |
| **Public, accountless submission over HTTP** | `POST /api/portal/[orgSlug]/[workspaceSlug]/feedback` with `portalAuthRequired = false` | `app/api/portal/.../feedback/route.ts` |
| **External identity when you do want it** | `PortalAccount` / `PortalSession` / `PortalVerificationToken`, magic link **and** SSO | `lib/portal-auth.ts`, `lib/portal-sso.ts` |
| **Per-workspace public-exposure toggle** | `roadmapPublic` and `feedbackEnabled` — one nullable boolean per public surface, defaulting to `false` | `prisma/schema.prisma` (`Workspace.feedbackEnabled`, `Workspace.roadmapPublic`), `lib/workspace-context.ts` |
| **Per-workspace identity policy + anti-spoof rule** | `portalAuthRequired` | `app/api/portal/.../feedback/route.ts` |
| Prototype identity + revisions + external URL | `Artifact` (`HTML_UPLOAD \| EXTERNAL_LINK`), `ArtifactRevision.externalUrl` | `prisma/schema.prisma` |
| Hashed, expiring, revocable public token | `ResearchParticipantToken` — hashed, expiring, **and** revocable via `revokedAt`. `PortalSession` is hashed and expiring but has **no `revokedAt`**; it is revoked by deleting the row (`deleteMany({ where: { tokenHash } })`) | `lib/research.ts`, `lib/portal-auth.ts` |
| **CORS on an unauthenticated, no-ambient-authority surface** | `OAUTH_CORS_HEADERS` — wildcard origin, `Allow-Credentials` never set, with the reasoning in its docstring | `lib/oauth/http.ts` |
| **Durable rate limiting on an unauthenticated surface** | Counter columns on the token row, bumped with optimistic-concurrency `updateMany` | `lib/research-session.ts` |
| External-URL safety validation | `normalizeResearchAppUrl` (rejects http in prod, credentials, private IP ranges) | `lib/research.ts` |
| Session-free route allowlist | `isPublicPath` | `lib/route-access.ts` |
| Promotion as a house idiom | `promote_feedback_to_roadmap`, `promote_research_finding_to_evidence`, `promote_to_roadmap` | `app/api/mcp/route.ts`, `lib/mcp-tool-gates.ts` |
| Fail-closed MCP tool gating | `applyToolGate` + completeness test | `lib/mcp-tool-gates.ts` |

**The public-access primitive Compass needs already exists and is already
policy-configurable.** `POST /api/portal/.../feedback` resolves identity like
this today:

```ts
if (workspace.portalAuthRequired) {
  const session = await getPortalSession();
  if (!session) {
    return NextResponse.json(
      { error: "Sign in required to submit feedback", code: "PORTAL_AUTH_REQUIRED" },
      { status: 401 }
    );
  }
  portalAccountId = session.portalAccountId;
  effectiveSubmitterEmail = session.email;
}
```

The last line is the anti-spoof property: `effectiveSubmitterEmail` was already
initialised from the client-supplied `submitterEmail` and is **overwritten** by
the session's email, so a signed-in visitor cannot claim an address they did not
verify. The route documents this in an inline comment immediately above the block
(`:145-148`): *"its email is authoritative — any client-supplied submitterEmail
is ignored so a signed-in visitor can't spoof a different address than the one
they verified."*

When `portalAuthRequired` is `false`, submission is **fully anonymous**:
free-text `submitterName`, optional `submitterEmail`, no session, no account.
One flag therefore already spans the whole range this feature needs, and this RFC
reuses that logic and that flag rather than inventing an access policy.

**One correction to how the source service has been characterised, here and in
the earlier draft.** The source service is *not* anonymous. Its widget refuses to post
without an established identity — the comment-submit handler returns early with a
"Sign in to comment" error unless a session exists, and every comment write goes
through a fetch helper that attaches the service's custom identity header whenever
a signed-in identity is present. Reads are
open to anyone holding the embed token; **writes require a sign-in.** What
The source service dispenses with is *workspace membership*, not identity.

So the honest mapping is:

| | Read | Write |
| --- | --- | --- |
| Source service | Embed token only — anonymous | Identity required (its own IdP), membership not |
| Compass, `portalAuthRequired = false` | Anonymous | **Anonymous** — more permissive than the source service |
| Compass, `portalAuthRequired = true` | Anonymous | Portal magic link / SSO, membership not — **the closest analogue** |

This is why the source service contains a nonce/popup/single-use-claim handoff at all: it
needed a cross-origin identity, and that is expensive. Compass's
`portalAuthRequired` covers both points on that spectrum with a single existing
flag, which is a better position than the source service is in. It also means
Open question 4 cannot be settled by appealing to "what the source service does" — see
[Open question 4](#open-questions-for-maintainers), which is reframed
accordingly.

### What genuinely does not exist

These are the real cost of this feature.

1. **`Comment` cannot represent an external author.** This is the decisive gap.
   `authorId` is nullable and `authorName` is free text, so a nameless outsider
   is *nearly* expressible — but there is **no email, no `portalAccountId`, and
   no provenance** anywhere on `Comment`, and `source` is `UI | MCP |
   MIGRATION`. `FeedbackItem` carries exactly the trio that is missing
   (`submitterName`, `submitterEmail`, `portalAccountId`). See
   [External authors](#external-authors--the-load-bearing-extension).
2. **The portal session cookie cannot travel cross-origin.**
   `compass_portal_session` is set `httpOnly, sameSite: "lax", path: "/"`.
   SameSite=Lax is not sent on cross-site subresource requests, so a widget on
   a prototype origin **cannot** authenticate with it via `fetch`, regardless of
   CORS headers. This is a hard constraint, not a configuration oversight, and
   it shapes Open question 4.
3. **No CORS on any portal or research route.** Every `/api/portal/*` and
   `/api/research/*` handler is same-origin by omission — no `Access-Control-*`
   header, no `OPTIONS` export, and two research routes actively *enforce*
   same-origin (`if (request.headers.get("origin") !== new URL(request.url).origin)`
   → 403). Cross-origin access to the public surface is the genuinely new
   transport. **CORS itself, however, is not new** — see
   [CORS](#cors), which follows an existing house helper rather than inventing
   one. Correcting the first draft, which claimed there was none anywhere.
4. **No rate limiting on the public write surface at all.** The portal feedback,
   vote, and 10 MB upload routes have zero counters, zero IP checks, and no 429
   path; their only defences are the workspace flags and field validation. The
   sole durable throttling *mechanism* on an unauthenticated surface anywhere in
   Compass is the counter-column pattern, which this RFC follows — implemented four
   times across the research surface, three of them on `ResearchParticipantToken`
   and one on `ResearchVoiceCall`, and **not** agreeing with itself about whether a
   write conflict should retry or surface a `409`.
5. **No route serves JavaScript.** Compass has never shipped a script to a
   third-party page. The closest precedents — `lib/artifact-preview-html.ts`,
   `components/research/research-experience.tsx` — are same-origin *sandboxed
   iframes*, the opposite direction.

---

## Engaging the documented stance

The User Guide is explicit about what artifact comments deliberately are not
(`docs/content/06-docs.md`):

> "Comments stay with the Artifact across revisions; **they are not pinned to
> coordinates or a particular revision**, and never constitute approval or
> authorization."

That sentence describes the feature this RFC proposes to extend, so it deserves
a direct answer rather than a footnote. Taking it clause by clause:

**"Not pinned to coordinates."** Honoured, and the design is built around it. The
anchor stores **no pixel coordinates**. It stores an element fingerprint and
**document-relative ratios** — `(rect.left + scrollX) / docEl.scrollWidth` —
precisely so it survives a different viewport width and a re-render. When
re-anchoring fails, the comment **degrades to an unanchored comment** and says
so, rather than pointing confidently at the wrong element. A design that pinned
coordinates would be strictly worse and this is not that design.

**"Not a particular revision."** This is the genuine tension, and the resolution
is that the anchor is **provenance, not scope**. `artifactRevisionId` records
*where the comment was placed*; the comment itself still belongs to the
`Artifact` and still appears in the whole-artifact thread on every later
revision, unchanged. The UI shows "placed on revision 3" and marks the anchor
stale if it cannot re-anchor on the current revision. Nothing is hidden,
scoped away, or version-gated. If maintainers would rather not record the
revision at all, the column is nullable and the feature degrades to
page-plus-element with no revision provenance — a real option, listed as Open
question 2.

**"Never constitute approval or authorization."** Unchanged, and this design
*strengthens* it. An anonymous comment from outside the workspace is the
last thing that should gate anything, and the only path from an anchored
comment to anything decision-bearing is an explicit human
[promotion](#promotion--where-triage-actually-begins).

### A note on vocabulary

The earlier draft called these "pins". **That word is taken.** `lib/panel-pin.ts`
uses "pin" for docking a side panel, `PANEL_IDS` already contains
`artifactComments`, and the literal on-screen control beside the artifact
preview is **"Pin panel"**. Shipping a second meaning of "pin" onto that exact
screen would be a lasting readability tax. This document uses **"anchored
comment"** throughout, and names the model `ArtifactCommentAnchor` to sit
beside `DocCommentAnchor`.

---

## Data model

**Three new tables** — an anchor, an identity extension, and a token — plus one
new workspace column and one widened TypeScript union. No new comment target
type, no new `PanelId`, and no change to any existing column on `Comment`.

Two of the three are 1:1 extensions keyed on `Comment.id`, which makes them the
**third and fourth** instances of a pattern the repository already uses twice
(`DocCommentAnchor`, `SolutionPlanProposal`).

Prisma requires the opposite side of every relation to be declared, so `Comment`
gains `artifactAnchor ArtifactCommentAnchor?` and `externalAuthor
CommentExternalAuthor?`, and `Artifact` gains `embedTokens ArtifactEmbedToken[]`.
None of those adds a column; `Comment.docAnchor` and `Comment.solutionPlanProposal`
already do exactly this.

### `ArtifactCommentAnchor` — where on the prototype the comment points

A 1:1 extension keyed on the parent's primary key, following `DocCommentAnchor`:

```prisma
model ArtifactCommentAnchor {
  commentId          String   @id @map("comment_id") @db.Uuid
  artifactId         String   @map("artifact_id") @db.Uuid
  /// Provenance, not scope: which revision the comment was placed on.
  /// Nullable — the comment still belongs to the Artifact across revisions.
  artifactRevisionId String?  @map("artifact_revision_id") @db.Uuid
  pageUrl            String   @map("page_url") @db.Text
  pagePath           String   @map("page_path") @db.Text
  elementSelector    String?  @map("element_selector") @db.Text
  /// { tag, text, rectXRatio, rectYRatio, rectWRatio, rectHRatio }.
  /// Ratios are DOCUMENT-relative, never pixels. See "Element re-anchoring".
  elementFingerprint Json?    @map("element_fingerprint")
  comment            Comment  @relation(fields: [commentId], references: [id], onDelete: Restrict, onUpdate: Restrict)

  @@index([artifactId, pageUrl])
  @@map("artifact_comment_anchors")
}
```

One deliberate departure from `DocCommentAnchor`, which declares **no `@@index`
at all** and no denormalized parent-scope column: the widget's hot query is
"every anchored comment for this artifact on this page", which wants
`artifactId` denormalized onto the anchor and `@@index([artifactId, pageUrl])`
to serve it. On DSQL that is an async index build and a real cost, so it is
called out rather than folded into "mirrors the existing pattern".

**Why an extension table rather than columns on `comments`.** Six nullable
widget-only columns would tax all 13 registered comment target types for a
minority feature, and `comments` is a deliberately shared record — its model
docstring calls `targetType + targetId` "deliberately polymorphic" and names
`lib/comments.ts` as "the single referential-integrity boundary". Its two indexes
(`idx_comments_target_status`, `idx_comments_parent`) carry no explanatory
comment, so their intent is inferred from shape rather than documented; both
would have to keep serving every target type unchanged. Two existing extension
tables already establish the house pattern for "anchor data only some rows have".

### External authors — the load-bearing extension

This is the one place Compass genuinely has to grow to support public
accessibility, and the shape is dictated by `FeedbackItem`, which already solved
this problem for the portal.

**On `Comment` itself, one new `source` member: `"WIDGET"`.** `source` is
already `@db.VarChar(20)` with default `"UI"`, so this is a TypeScript union
widening with **no migration**. `source` is the correct axis — it means "how did
this arrive" — and it composes cleanly with the existing `authorId`:

| `authorId` | `source` | Means |
| --- | --- | --- |
| set | `UI` | Workspace member, in Compass. Unchanged. |
| set | `WIDGET` | Workspace member reviewing the prototype itself. |
| `null` | `WIDGET` | **External reviewer.** The new case. |
| `null` | `MCP` | Agent. Unchanged. |

Deliberately **not** proposed: a third `authorType` member. `authorType` is
`HUMAN | AGENT` and means "who typed this". An outside reviewer is a human;
adding `EXTERNAL` there would conflate two independent axes, and `source`
already carries provenance.

**Contact detail goes in a 1:1 extension**, so the sensitive fields are absent
by default and are not joined by the comment list:

```prisma
model CommentExternalAuthor {
  commentId       String         @id @map("comment_id") @db.Uuid
  /// Mirrors FeedbackItem.submitterEmail / .portalAccountId exactly.
  submitterEmail  String?        @map("submitter_email") @db.VarChar(255)
  portalAccountId String?        @map("portal_account_id") @db.Uuid
  /// Which snippet this arrived through — revocation and abuse triage.
  embedTokenId    String?        @map("embed_token_id") @db.Uuid
  createdAt       DateTime       @default(now()) @map("created_at")
  comment         Comment        @relation(fields: [commentId], references: [id], onDelete: Restrict, onUpdate: Restrict)
  portalAccount   PortalAccount? @relation(fields: [portalAccountId], references: [id], onDelete: Restrict, onUpdate: Restrict)

  @@index([portalAccountId])
  @@map("comment_external_authors")
}
```

`Comment.authorName` is already `NOT NULL VarChar(255)`, so the reviewer's
display name needs no new column — it goes where every other author's name goes.
Anonymous submitters supply it as free text, exactly as `FeedbackItem.submitterName`
works today.

**The identity rule is copied verbatim from the portal feedback route**, because
its anti-spoof property is the reason it is written that way: *if
`portalAuthRequired` is set, a portal identity is mandatory and its email is
authoritative — any client-supplied email is ignored,* so a signed-in visitor
cannot claim an address they did not verify. `PortalAccount` also gains a
back-relation `externalComments CommentExternalAuthor[]`.

### `ArtifactEmbedToken` — the credential in the `<script>` tag

Modelled on the *pattern* of two existing tables, but they contribute different
parts of it and the difference matters. **Both** `ResearchParticipantToken` and
`PortalSession` supply the hashed-token / expiry / `lastUsedAt` shape. Only
`ResearchParticipantToken` supplies the other two properties: an explicit
`revokedAt` column, and the choice to keep abuse counters **on the token row**.
`PortalSession` has no `revokedAt` (it is revoked by deleting the row) and no
counters at all, so it is cited here for shape alone — as it is in the
[reuse table](#what-already-exists-the-reuse-case) — and not as a precedent for
either.

That second property is not stylistic: the counter-column approach is the **only**
durable rate-limit *mechanism* on any unauthenticated surface in Compass — though
it is implemented **four** times over, not once, and the RFC's earlier drafts
named only one of them. Three bump counters on `ResearchParticipantToken`
(`lib/research-session.ts:105-167`, `lib/research-participant-voice.ts:38-48`,
`lib/research-voice-control-plane.ts:196-240`) and a fourth bumps
`commandWindowCount`/`commandTotalCount` on `ResearchVoiceCall`
(`lib/research-voice-operations.ts:336-364`). The alternative in the
repo, `lib/oauth/rate-limit.ts`, is in-memory and its own docstring disclaims
it — *"not a distributed rate limiter … a cold start resets a caller's
window"* — and it is wired to exactly one route. The portal's public write
routes have no rate limiting whatsoever. So a widget endpoint that ships with
per-token counters is *stricter* than the surface it sits beside, which is the
right direction for a new public write path.

Bumping a counter must use the same optimistic-concurrency `updateMany` guarded
on the prior window/count values, because Aurora DSQL raises a write conflict
(P2034) rather than blocking — `lib/research-session.ts:105-167` is the pattern to
copy, including its `retryDsql` wrapper (`:88-103`, 3 attempts on `P2034`).

**But the four implementations disagree on what to do about the conflict, and the
one closest to this RFC's shape disagrees with the one it cites.**
`research-session.ts` retries. `research-participant-voice.ts:38-48` — the only
existing implementation that uses exactly **two** window/count pairs in a single
`updateMany`, i.e. precisely the shape proposed below — deliberately does *not*
retry: it throws `ResearchVoiceError("Voice connection changed concurrently", 409)`
at `:48` and lets the caller deal with it, reserving `429` for the actual rate-limit
rejections at `:43-44`. **Which behaviour the widget should have is worth raising
with maintainers.** A retry is friendlier to a reviewer who is mid-comment and would
otherwise lose it; a `409` is simpler, and it is already precedented at exactly this
shape. This RFC recommends the retry on the grounds that losing a typed comment to a
write conflict is a much worse outcome than losing a voice reconnection, but it is a
genuine choice and not a copy-the-pattern exercise.

It is not field-for-field with `ResearchParticipantToken`. That model carries
**ten** throttling columns forming **five** window/count pairs — `start`,
`response`, `agent`, `voice`, and `voiceDay` — because a research session has
five things worth throttling, and two of its counters (`voiceCount`,
`voiceDayCount`) additionally carry `@default(0)` where the older three do not.
A widget has two things worth throttling, so it gets two pairs, defaulted
consistently. `label` is an addition with no counterpart, for telling two live
snippets apart in an admin list.

```prisma
model ArtifactEmbedToken {
  id             String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  artifactId     String    @map("artifact_id") @db.Uuid
  tokenHash      String    @unique(map: "idx_artifact_embed_tokens_hash") @map("token_hash") @db.VarChar(64)
  kind           String    @default("PRIMARY") @db.VarChar(30)
  label          String?   @db.VarChar(255)
  expiresAt      DateTime  @map("expires_at")
  revokedAt      DateTime? @map("revoked_at")
  lastUsedAt     DateTime? @map("last_used_at")
  createdAt      DateTime  @default(now()) @map("created_at")
  createdById    String?   @map("created_by_id") @db.Uuid
  readWindowAt   DateTime? @map("read_window_at")
  readCount      Int?      @map("read_count")
  submitWindowAt DateTime? @map("submit_window_at")
  submitCount    Int?      @map("submit_count")
  artifact       Artifact  @relation(fields: [artifactId], references: [id])

  @@index([artifactId, kind, revokedAt], map: "idx_artifact_embed_tokens_artifact_kind")
  @@map("artifact_embed_tokens")
}
```

The omitted `onDelete`/`onUpdate` on `artifact` is deliberate, not an oversight, even
though this RFC's other three proposed relations all specify
`onDelete: Restrict, onUpdate: Restrict`. It mirrors the model this one is copied
from: `ResearchParticipantToken.study`, `PortalSession.portalAccount`,
`Artifact.workspace`, and `ArtifactRevision.artifact` all omit them too. Maintainers
who would rather have consistency within this RFC than fidelity to its precedent
should add them; nothing else changes.

Minting and verification follow the existing helpers' shape: 32 random bytes
rendered `base64url` as the plaintext token, and a SHA-256 hex digest of it
stored in the column. Both existing call sites wrap the digest in a **named
helper** rather than inlining it — `hashResearchToken()` in `lib/research.ts`,
`hashToken()` in `lib/portal-auth.ts` — so a third surface should add its own
(`hashEmbedToken()`) beside them rather than repeat the `createHash` call:

```ts
// beside hashResearchToken / hashToken
function hashEmbedToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

const token = randomBytes(32).toString("base64url")
const tokenHash = hashEmbedToken(token)
```

**Why a token at all, if the workspace flag already makes the surface public?**
Because the token is what makes the surface *narrow*. It names exactly one
artifact, so a snippet cannot post against a different one; it is revocable
individually, so pulling one leaked snippet does not disturb the others; and it
carries the rate-limit counters. The alternative — an open write endpoint plus a
plaintext artifact UUID in the page — gives up all three.

**Why a hashed DB token and not a stateless HMAC.** The source service's embed
credential is a versioned, self-describing HMAC: the scope and an expiry are encoded
in the token body and signed with a single service secret. It is fast and needs no
read — but it **cannot be revoked**. Pulling one leaked snippet means rotating the
secret, invalidating every snippet everywhere at once.
Compass has already made that trade twice: both `resolveActiveResearchStudy` and
`getPortalSession` look a hashed token up in the database rather than verifying a
signature, and both indexes exist to serve it (`idx_research_participant_tokens_hash`,
`PortalSession.tokenHash @unique`). What they buy is per-token revocation,
`lastUsedAt`, and somewhere to hang rate-limit counters. No benchmark is offered
here for what that lookup costs on DSQL — the argument is that Compass has
already accepted the cost on two comparable surfaces, not that it is free.

**The source service has since reached the same conclusion**, which is worth saying
because it means this RFC is not departing from that design so much as following
where it has already gone. Its most recently added credential is deliberately *not*
another self-contained HMAC: it is an opaque random string whose meaning lives
entirely in a database row, and its own implementation notes give the reason as
revocability — one token can be withdrawn without disturbing any other. So the
recommendation here is not this RFC's invention, and not an argument resting on
Compass precedent alone; it is the conclusion the prior art arrived at
independently, after operating the stateless version.

**Scoping.** The token *is* the tenant context: token → `Artifact` →
`workspaceId`, mirroring token → `ResearchStudy` → `workspaceId` exactly,
including the rule that there is no cookie and no membership check on the public
path. Note the source service's token payload optionally carries a third segment
scoping a token to a single **page**; the Compass analogue would be a nullable
`artifactRevisionId` on the token. Not proposed for Phase 1 (`EXTERNAL_LINK`-only,
revisions do not yet vary per snippet) but cheaper to add now than to backfill.

### Everything else is reuse

| Concept | Storage |
| --- | --- |
| The anchored comment | `Comment`, `targetType: "ARTIFACT"`, `targetId: artifact.id`, `source: "WIDGET"` — **no change to the target-type registry** (`source` does gain one member, which is a `VarChar(20)` value and needs no migration) |
| Its body | `Comment.body` |
| Its title | **None needed.** A comment has no title — this removes the earlier draft's worst impedance mismatch, where `FeedbackItem.title` was `NOT NULL` and had to be synthesised from prose |
| Replies | `Comment` with `parentId` — the existing one-level threading, no new plumbing |
| Resolved / unresolved | `Comment.status` (`OPEN` / `RESOLVED`) — the existing semantics |
| Thread UI, in-app | `<Discussion targetType="ARTIFACT">` with `DocPanelShell panelId="artifactComments"` supplied as its `render` prop — **already shipped by #275** |
| Where it points | `ArtifactCommentAnchor` (new) |
| Who left it | `Comment.authorName` + `CommentExternalAuthor` (new) |
| Element screenshot | See Open question 1 — this is the one attachment question, and `Comment` has no attachment relation today |
| The prototype | `Artifact`, `sourceType: "EXTERNAL_LINK"` in Phase 1, URL in `ArtifactRevision.externalUrl` |
| Reviewer identity | `PortalAccount` via existing magic link / SSO, or anonymous |
| Public exposure policy | New workspace flag, following `roadmapPublic` (below) |

### Workspace flag

The two existing public-surface flags sit adjacently on `Workspace`
(`prisma/schema.prisma:199-200` as of `e534bf81`) and share a *shape* but not a
naming convention: `roadmapPublic` is
`<surface>Public`, `feedbackEnabled` is `<surface>Enabled`. So there is no
settled idiom to follow, only a settled shape — one nullable boolean per public
surface, defaulting to **off**. `artifactFeedbackPublic` picks the `Public` form
because the flag governs *exposure*, not whether the feature exists; maintainers
may prefer `artifactFeedbackEnabled` and the choice is cosmetic:

```prisma
artifactFeedbackPublic Boolean? @default(false) @map("artifact_feedback_public")
```

Checked in **both** places the existing flags are, which is the pattern
`roadmapPublic` demonstrates: the route returns `403` (as
`app/api/portal/.../vote/route.ts` does) and the public page renders an
explanatory empty state. Note the page does **not** `notFound()` — there is no
`notFound()` call anywhere under `app/portal`. `app/portal/.../roadmap/page.tsx:46-52`
returns HTTP **200** with `<EmptyState title="This roadmap is not public" …/>`,
which is a deliberate difference: a 404 would leak nothing but also tell a
visitor with a legitimate link that they had the wrong URL. The widget's public
artifact page should copy the `EmptyState`-at-200 behaviour, not invent a 404.

The flag also belongs in the `lib/workspace-context.ts` selection and in
`components/settings/portal-settings-panel.tsx` beside its **four** siblings
(`feedbackEnabled`, `roadmapPublic`, `portalAuthRequired`, `ssoEnabled`).

Two integration details that are easy to miss. There is **no `portalEnabled`
column** — "is this workspace public at all" is *derived*:

```ts
// components/settings/portal-settings-panel.tsx
const portalIsPublic = feedbackEnabled || roadmapPublic;
```

That derivation gates whether the **"Require an account"** and **SSO** toggles
are rendered at all, so `artifactFeedbackPublic` must join it — otherwise a
workspace could expose a public widget while the control governing its identity
policy stays hidden.

The new flag has to be threaded through **two** places that each enumerate the
existing four explicitly, neither of which is inferred from the schema:

- `components/settings/portal-settings-panel.tsx:52` — a closed union of
  literal field names, `"feedbackEnabled" | "roadmapPublic" | "portalAuthRequired" | "ssoEnabled"`.
- `app/[orgSlug]/[workspaceSlug]/settings/actions.ts:858-881` — an input type of
  four optional booleans, each spread into the update conditionally
  (`...(input.feedbackEnabled !== undefined && { feedbackEnabled: input.feedbackEnabled })`).
  This is a repeated per-field line, not a union, so a flag omitted here fails
  silently rather than failing to compile.

Identity policy is **not** a new flag — `portalAuthRequired` already governs it
and is reused unchanged. Worth noting its scope is coarse: one flag governs
feedback submission, feedback voting, roadmap voting, and attachment upload
simultaneously, and widget writes would become a fifth consumer. If maintainers
want per-surface identity policy, that is a pre-existing question this RFC
inherits rather than creates.

`ssoEnabled` is orthogonal and needs no change: the settings panel documents
that SSO may be on with `portalAuthRequired` off, in which case anonymous
commenting is still allowed but SSO visitors arrive with a verified identity —
which is a good outcome for prototype review and requires nothing new here.

### DSQL obligations

`relationMode = "prisma"` means no FK constraints, so deletes are hand-rolled.
Deleting an anchored comment must delete, in order: its `ArtifactCommentAnchor`,
its `CommentExternalAuthor`, its replies, then the comment. There are **three**
sites that remove a `Comment` row, not one, and all three must be extended:

| Function | Reached from | Already deletes | Transactional? |
| --- | --- | --- | --- |
| `deleteComment()` in `lib/comments.ts:165-176` | MCP `delete_comment` (via `lib/comment-tool-handlers.ts:29`) and `lib/comment-compat.ts:43` | `DocCommentAnchor`, then `SolutionPlanProposal` | **No** — six un-wrapped `prisma` calls, four of them deletes, two of the six conditional on whether the comment is a thread root |
| `deleteBrowserComment()` in `lib/comment-browser.ts:85-117` | `app/api/comments/[id]/route.ts:44` (the in-app UI path) | `DocCommentAnchor` only — it throws `404` at `:92` for any comment carrying a `SolutionPlanProposal` rather than cascading it | **Yes** — a `$transaction` at `{ isolationLevel: "RepeatableRead" }` (`:87-106`) wrapped in a 3-attempt retry loop (`:108-115`) |
| `createComment()`'s rollback in `lib/comments.ts:121-127` | **Every** create path | Nothing — it deletes the `Comment` only | **Conditionally** — see below. When it is not transactional, this is a compensating delete that removes the parent and leaves extension rows behind |

The second row was the hazard the fourth pass caught: a reviewer deleting a widget
comment from the in-app thread UI takes the `comment-browser` path and would orphan
**both** new rows. In those two functions the change is two more `deleteMany` calls
keyed on the same `ids` array both already build — mechanically small.

**The third row is different in kind, and this RFC is what makes it dangerous.**
`createComment` creates the comment, then creates its extensions inside a `try`
(`lib/comments.ts:122-123`); on failure the `catch` deletes the comment —
`if (!capture) await tx.comment.delete({ where: { id: comment.id } })` at `:125` —
without deleting any extension row that already succeeded. Today that is safe for
a reason that has nothing to do with the rollback being careful: `validateExtensions`
(`lib/comments.ts:82-90`) makes the two existing extensions **mutually exclusive by
target type** — `docAnchor` is rejected unless `targetType === "DOC"`, `solutionPlan`
unless `targetType === "SOLUTION"` — so at most one extension create can run, and if
that one is the one that threw there is nothing left over.

This RFC proposes two extensions (`ArtifactCommentAnchor` and
`CommentExternalAuthor`) that both apply to the **same `ARTIFACT` comment**. That
removes the guarantee. If the anchor create succeeds and the external-author create
fails, the compensating delete removes the comment and leaves the anchor row
orphaned — the exact defect this section exists to prevent, arriving on the create
path instead of the delete path, with no FK to catch it.

The `if (!capture)` guard is the whole subtlety. `createComment` wraps its work in
`withWorkspaceUpdates` (`lib/comments.ts:110`), which has three modes
(`lib/workspace-updates-capture.ts:95-108`): it reuses an in-flight tool transaction,
or runs **without a transaction** when the workspace-updates migration is not applied
(`capture = false`), or opens a real retrying transaction (`capture = true`). The
compensating delete fires only in the non-transactional modes — precisely the modes
where nothing will roll back for it. So the orphan window is real but
environment-dependent, which makes it the kind of bug that passes review and
surfaces later on one deployment and not another.

**Two fixes are available and this is worth settling with maintainers before any
code is written:** either the `catch` deletes both extension rows explicitly, or the
whole create moves inside a transaction unconditionally. The second is preferable
because it also closes the asymmetry in the table above — the same logical delete is
atomic on the UI path and six bare sequential calls on the MCP path. Adding two more
dependent deletes widens the window in which `deleteComment()` can fail halfway.
**Whether all three sites should converge on the transactional form is the single
most useful thing maintainers could decide about this RFC**, because it determines
whether the anchor and external-author tables are safe to add at all.

Creating an anchored comment also needs a new field on `CreateCommentInput` and a
third clause in `validateExtensions` (`lib/comments.ts:82-90`), which today
hard-codes the two target-type rules above. The RFC's read path needs one more
thing: `resolveCommentAuthors` (`lib/comment-authors.ts`, added by #288) now runs on
every comment read — `lib/comments.ts:142` and `:147`, `lib/comment-browser.ts:82`,
`lib/doc-comments.ts:98`, `:115`, `:121`, `:140`, `:159` — and rewrites `authorName`
from the live `User` row, but **only** when `authorType === "HUMAN"` *and* `authorId`
is non-null. Widget comments carry a null `authorId`, so they pass through untouched
and the denormalised `authorName` stands. That is the correct behaviour, but it is
load-bearing and currently accidental: relaxing that `authorId` filter would silently
clobber every external author's name. `resolveCommentAuthors` is also the natural
place to join `CommentExternalAuthor` for display, and this RFC proposes it as such.

Workspace-level deletion is an **asymmetry**, not an absence. A full comment
cascade does exist — `lib/preview-automation/service.ts:30-33` deletes
`docCommentAnchor`, then `solutionPlanProposal`, then null-outs `parentId` across
the workspace's comments, then deletes the comments, all before calling
`deleteWorkspaceCascade(...)` at `:46`:

```ts
await prisma.docCommentAnchor.deleteMany({ where: { comment: { workspaceId } } });
await prisma.solutionPlanProposal.deleteMany({ where: { comment: { workspaceId } } });
await prisma.comment.updateMany({ where: { workspaceId }, data: { parentId: null } });
await prisma.comment.deleteMany({ where: { workspaceId } });
```

So there **is** an existing list of comment tables to append to, and the new
tables join it exactly as they join the two per-comment functions above. What is
asymmetric is that this list lives in the *preview-automation* teardown path
rather than in `lib/delete-workspace-cascade.ts`, which deletes `solutionComment`
rows but no `comment`, `docCommentAnchor`, or `solutionPlanProposal` rows. Any
caller of `deleteWorkspaceCascade` that is not preview-automation therefore
leaves shared comments behind today. That predates this RFC and this RFC does not
fix it — but the new tables must be added to the preview-automation list, and
**"should the comment cascade move into `delete-workspace-cascade.ts`?" is worth
raising with maintainers** rather than quietly adding two more tables to a list
in the wrong file.

Migrations land as `prisma/migrations/062_artifact_comment_anchors`. **`062` is
the next free prefix** — the highest existing is `061_product_analytics` — and
picking it matters more than it looks, because the repository already
carries duplicate prefixes at **024, 034, 047 (three), 049, 050, 051, 054
(three), and 055** — eight prefixes. (`009` looks like a ninth on the filesystem,
but is not: the second entry is a stray `prisma/migrations/009_feedback_voting.sql`
that the `MIGRATIONS` array never references, so it is dead weight rather than a
tolerated collision.) The real duplicates are tolerated rather than intentional:
the runner keys
on the exact directory name, so a collision is not a bug to "fix" and the
existing ones must not be renumbered. `docs/decisions/0012` nonetheless asks
that further duplicates be avoided, which rules out `055` as well as `054` —
both already have more than one occupant. The migration must be appended to the
`MIGRATIONS` array in `lib/migrations/runner.ts` and applied through
`POST /api/admin/migrate`, never `prisma db push`. Because the new tables carry
an async index, the migration also belongs in `ASYNC_WAIT_MIGRATIONS` in the same
file (`:529`), alongside the three most recent entries. Indexes build
asynchronously on DSQL, so no query may assume one exists.

**Re-check this prefix at merge time rather than trusting it.** `059` through
`061` were all free when the fifth pass ran and all three were occupied by the
sixth, eleven days later — `059_geode_document_storage`, `060_workspace_updates`,
and `061_product_analytics` (`lib/migrations/runner.ts:366`, `:370`, `:374`).
This is the second time this document has had to move its own migration number,
and the number is the single most perishable claim in it.

---

## Promotion — where triage actually begins

An anchored comment is discussion. Some fraction of it is a real bug or a real
idea that needs a status, a vote count, an owner, and a path to the roadmap.
Compass already has a word and a shape for that transition:
`promote_feedback_to_roadmap`, `promote_research_finding_to_evidence`,
`promote_to_roadmap`.

So: **`promote_artifact_comment_to_feedback`**. It creates a `FeedbackItem` in
the same workspace and carries the comment body into `description`. The submitter
trio comes from **two** records, not one, because `CommentExternalAuthor`
deliberately has no name column:

| `FeedbackItem` column | Source |
| --- | --- |
| `submitterName` | `Comment.authorName` — where every author's name already lives |
| `submitterEmail` | `CommentExternalAuthor.submitterEmail` |
| `portalAccountId` | `CommentExternalAuthor.portalAccountId` |

It then links back to the originating comment. `FeedbackItem.title` is `NOT NULL`,
so promotion is also where a title finally has to exist — which is fine, because
a human is present at promotion time and can supply one. That is precisely the
cost the earlier draft paid on *every* capture.

This is what makes the small primary record defensible. The earlier draft
reached for `FeedbackItem` at *capture* time because capture needed triage; the
correct reading is that **capture is discussion and triage begins at
promotion**. Every traceability claim in Motivation survives intact —
`opportunityId`, `voteCount`, the six-state lifecycle, the roadmap path — it is
simply reached deliberately by a human rather than imposed on every stray
"this text is too small".

It also preserves the User Guide's boundary: promotion is the explicit human act
that converts discussion into something decision-bearing.

---

## API surface

Four routes under a new `/api/embed/` prefix. One deliberate omission from the
source service's surface is called out after the table.

| Route | Method | Purpose | Auth |
| --- | --- | --- | --- |
| `/api/embed/widget.js` | `GET` | Serves the widget script | Embed token verified **server-side before the body is generated**; failure returns a JS file that logs one diagnostic and does nothing |
| `/api/embed/comments` | `GET`, `POST`, `OPTIONS` | List / create anchored comments for the token's artifact | Embed token; `POST` additionally honours `portalAuthRequired` (Open question 4) |
| `/api/embed/comments/[id]` | `PATCH`, `OPTIONS` | Reply, or set status | Embed token + identity; a reviewer may only act on their own comment |
| `/api/embed/comments/[id]/screenshot` | `GET` | Streams the element screenshot | Embed token, re-authorised per request (Open question 1) |

**One capability is deliberately absent from that table.** The source service lets
a reviewer delete their own comment from the widget: a `DELETE` handler gated by an
ownership check, reached from the widget by the same identity-bearing fetch helper as
its other writes. Worth copying from its design if this is ever added: the handler
distinguishes *owner* from *administrator* and answers `403` rather than `404` to an
owner, so a reviewer probing an ID never learns whether someone else's comment
exists. This RFC
does not propose it, for two reasons worth stating rather than leaving as an
oversight. First, deletion is the operation with the two-path cascade hazard
described under [DSQL obligations](#dsql-obligations); adding a *third* entry
point in Phase 1, on a public surface, multiplies the orphan risk before the
existing two paths are even aligned. Second, `Comment.status` already gives a
reviewer a non-destructive retraction, and a resolved comment preserves the
discussion record that the promotion path depends on. If maintainers want
reviewer self-delete, it should be a follow-on that routes through whichever
single cascade helper the two existing paths get consolidated into — not a fourth
hand-rolled sequence.

`isPublicPath` in `lib/route-access.ts` gains one entry, in the file's existing
style of a comment that justifies itself:

```ts
// Embedded prototype widget. Reviewers are anonymous or portal-authenticated
// and the page is cross-origin, so these handlers validate a hashed, expiring
// artifact embed token themselves — the same pattern as /api/research/*.
pathname.startsWith("/api/embed/") ||
```

Every handler resolves `workspace.artifactFeedbackPublic` and, on writes,
`workspace.portalAuthRequired`, before touching a comment.

### CORS

**Compass already has a CORS helper, and it already encodes the right rule.**
`lib/oauth/http.ts` serves the unauthenticated OAuth discovery, `/register`,
`/token`, and `/revoke` endpoints, and its docstring states the security
argument this RFC would otherwise have had to make from scratch:

> *"It looks alarming and is not. Every endpoint that uses these headers … is
> unauthenticated by design and carries no ambient authority: no cookie, no
> session, no `Authorization` header is consulted. `Allow-Credentials` is never
> set, so a browser will not attach cookies to these cross-origin requests even
> if one existed. … The endpoints that do carry ambient authority —
> `/oauth/authorize` and `/oauth/consent`, which run under the Auth.js session
> cookie — deliberately have no CORS headers at all and are same-origin only."*

That is exactly the shape `/api/embed/*` needs, so the proposal is to **follow
this helper rather than write a second one**: wildcard origin, no credentials,
ever. Note the house pattern is a literal `*` and *not* an echoed `Origin` — a
wildcard cannot be combined with credentials even by accident, whereas an echoed
origin becomes catastrophic the moment someone later adds
`Allow-Credentials`. The wildcard is the more defensive default and it is
already in the repository; an earlier draft of this RFC proposed echoing the
origin, which was strictly worse.

In fairness to the source service, the gap here is narrower than the previous
draft implied. It **already falls back to `*`**, and for the same stated reason
this RFC gives: it treats a literal `Origin: null` — which is what an opaque
origin sends — as equivalent to a missing origin, because echoing
`Access-Control-Allow-Origin: null` back is spec-allowed but inconsistently
honoured, and several recent browser versions reject it outright. It records the
same never-`credentials: "include"` invariant as the justification for the
wildcard being safe. The disagreement is therefore only about the case where an
`Origin` header is present and non-opaque: the source service echoes it, Compass
sends `*`. Both rest on the identical never-credentials invariant. Compass's is
the stricter reading of that invariant, which is why it should win — not because
the source service was careless about it.

`Access-Control-Allow-Credentials` appears **zero times** in the repository
today. Whatever else this RFC does, it must not be the change that introduces
it. Recommended: extract the shared shape into `lib/cors.ts`, or simply add an
`EMBED_CORS_HEADERS` constant beside the OAuth one with the same invariant
restated — maintainers' preference on factoring.

Two consequences, both counter-intuitive:

1. **`getPortalSession()` cannot authenticate a widget write, and not only
   because of CORS.** `compass_portal_session` is `sameSite: "lax"`, which
   browsers do not send on cross-site subresource requests at all. Even with
   permissive CORS the cookie would simply be absent. Identity must therefore be
   exchanged for a short-lived bearer token the widget holds in memory — or the
   reviewer stays anonymous, which is the default and needs nothing.
2. **`text/plain` bodies avoid a preflight, and the source service's own two
   uses of it land on opposite sides of that.** The source service sends `text/plain` to
   stay inside the CORS "simple request" set, in exactly two places:

   - **The sign-in handoff poll**, which runs once a second and sends no identity
     header. Its own inline note says `text/plain` is what keeps every poll a
     simple request with no preflight, and here it genuinely pays. Note this is a
     `POST`, not a `GET` — the saving is about the *simple-request* rule, not about
     reads versus writes, and the earlier framing of "only on reads" was the wrong
     axis.
   - **The comment write**, where it no longer pays anything. That path cannot be
     reached at all unless the reviewer is signed in, so it always carries the
     service's custom identity header, and a custom header forces a preflight
     regardless. The source's own note concedes this: the `text/plain` choice
     predates the identity header, and switching the content type now would buy
     nothing. Its header constant is documented as costing one extra round-trip on
     writes — not correctness.

   Note that "always carries the header" is a property of *that call site*, not of
   the fetch helper: the helper attaches the identity header only when a session
   exists, and the widget's own delete path deliberately calls it with no sign-in
   precondition and handles the server's refusal afterwards. So the invariant is
   "every *comment* write is identified", not "every write is". The claim poll above
   is itself a `POST` and goes out with no identity header at all, which is exactly
   why `text/plain` still earns its place at that one site. Compass's situation
   differs in one important way: with
   `portalAuthRequired = false` there is no identity header, so a `text/plain`
   body would keep an **anonymous write** inside the simple-request set and
   genuinely save the preflight. So: keep `text/plain` and comment *why* at each
   site — it pays on polls and on anonymous writes, and buys nothing once an
   identity header is attached. Server handlers must parse the body as JSON
   regardless of content type, as the source service's do — it branches on the
   incoming `Content-Type` and `JSON.parse`s a raw text body when it sees
   `text/plain`. `OPTIONS` is still required on the write routes for the identified
   case.

---

## The widget

The one genuinely un-Compass-like artifact in this proposal. Honest accounting:

- Vanilla JavaScript. In the source service it is a **single template literal
  inside one route handler**, and that route file is the largest hand-written file
  in its repository — roughly 3,600 lines, the overwhelming majority of it that one
  literal, plus a ~2,300-line test file for the one route. Sizes are given as
  orders of magnitude, not as an invitation to match them: the point is that this
  is the shape to avoid, and it is quantified only so the cost of *not* avoiding it
  is legible.
- Renders into a **Shadow DOM** host so the prototype's CSS cannot bleed in and
  the widget's cannot bleed out. Anchor markers render in a *separate* container
  outside the shadow root so they can be absolutely positioned over host
  elements.
- **`pnpm ui:colors` and `pnpm ui:primitives` do not apply to it.** It shares no
  React tree, no Tailwind pass, and no design tokens with the app. The PR
  template's UI-system checklist should be read as N/A for the script itself and
  fully in force for the in-app UI in Phase 3. Flagging this rather than silently
  ticking boxes.

**Recommendation: do not port it as one template literal.** Compose it from
modules under `lib/embed/widget/` that are individually unit-testable. The source
service has already proved out the seam that works: the element-matching,
safe-storage, and nonce logic live in a module as **exported string constants with
real unit tests**, and those constants *are* what gets injected into the page. That
inversion is the whole trick — the tested artifact and the shipped artifact are the
same bytes.

It has also proved out the seam that **does not** work, and that one is worth
naming because it is the tempting version. A second module extracts the widget's
valid position values into ordinary TypeScript — and its own docstring concedes
that the injected script is plain client-side JS which **cannot import it**, so
the module is a hand-maintained *mirror* and the template literal remains the real
source of truth. A module boundary the consumer cannot cross is worse than no
boundary at all, because it reads as shared code while the copy that actually
ships is unreachable from it and drifts silently. Design that out from the start:
if the widget cannot import it, it must be generated from it.

### Element re-anchoring

A CSS selector alone does not survive a prototype redeploy. The scheme worth
porting, verbatim in behaviour, and the reason this design can honestly claim it
does not pin coordinates:

Capture `{ tag, text, rectXRatio, rectYRatio, rectWRatio, rectHRatio }` where
each ratio is **document-relative** — `(rect.left + scrollX) / docEl.scrollWidth`
— not an absolute pixel offset. On render, try the exact selector first, score
the match (text similarity weighted 0.55, geometry 0.45; a different tag is
disqualified outright), and only if the score falls below threshold scan all
same-tag elements for a better candidate. Below threshold with no candidate, the
comment renders **unanchored and flagged stale** rather than misplaced.

This is the same philosophy as `DocCommentAnchor`, which re-finds its target by
`anchorText` with prefix/suffix context and treats `anchorStart`/`anchorEnd` as
hints rather than truth.

### Screenshot capture — two failure modes that cost real debugging time

These are the highest-value lines in this document. Both were found the hard way
and both will be silently reintroduced by anyone who "modernises" this code.

**And they are not hypothetical for Compass.** `ARTIFACT_IFRAME_SANDBOX` in
`components/artifact-sandboxed-frame.tsx` is `"allow-scripts"` — deliberately
**without** `allow-same-origin` — and `lib/artifact-preview-html.ts` injects a
`default-src 'none'` CSP into the child. So Compass's own artifact preview
already renders on an opaque origin, in both the authenticated docs viewer and
the unauthenticated research participant experience. Any future attempt to
capture a screenshot from inside that preview hits precisely the two failure
modes below, whether or not this RFC is ever implemented.

1. **The rasteriser must not create an iframe.** `html2canvas` and
   `modern-screenshot` both render by creating an iframe and reading its
   document. Under a CSP `sandbox` header without `allow-same-origin` the
   document has an **opaque origin**, that read is cross-origin, and it throws
   `SecurityError`. `html-to-image` rasterises through an SVG `foreignObject` and
   never creates an iframe. This constrains the library choice, and the library
   should be vendored with a recorded hash rather than pulled from a CDN onto a
   host page.
2. **Detect an opaque origin with `window.origin`, not `location.origin`.**
   Inside a sandbox, `location.origin` still reports the real `https://…` origin
   while `window.origin` — the settings-object origin — is literally the string
   `"null"`. A first implementation used `location.origin`, looked correct, and
   was caught only by an end-to-end test.

Also worth carrying over, and verified against the source rather than recalled:
filter out `<img>` elements the rasteriser cannot inline, because
`html-to-image` reproduces an image by fetching its bytes to a data URI and a
fetch it cannot read **rejects the whole capture** rather than dropping that one
node (the library's own `imagePlaceholder` option does not rescue it — the source
notes this as measured). The rule is *keep `data:` URIs and same-origin URLs,
drop everything else*, **with one refinement the naive version misses**: under an
opaque origin the filter must keep `data:` URIs *only*, because there a fetch of
even a same-host URL is a cross-origin request carrying `Origin: null` and fails
without an explicit ACAO. Resolving `src` against `location.href` and comparing
would wrongly keep an image that cannot be fetched — the same
`window.origin`-vs-`location.origin` trap as above, reappearing in a second
place. An origin that cannot be determined at all falls to the same conservative
branch.

Also publish capture state (`pending | ok | blank | error`) as a data attribute
on the host so tests and field debugging can observe an otherwise closure-local
variable.

---

## MCP surface

Most of what an agent needs already exists, but less of it than a first reading
suggests. `commentTargetSchema` (`app/api/mcp/route.ts:264`) already contains
`"ARTIFACT"`, and **two** tools take it: `add_comment` (:265) and `list_comments`
(:266). The other five — `get_comment` (:267), `update_comment` (:268),
`delete_comment` (:269), `resolve_comment` (:270), `reopen_comment` (:271) — are
keyed on `commentId` alone and never mention a target type, so they work on an
anchored comment for free but are not evidence of artifact support.

That distinction matters for the Phase 1 claim below: `add_comment` +
`list_comments` are genuinely enough for an agent to write and read anchored
comments, but neither accepts anchor fields, so Phase 1's MCP path either
extends those two with optional anchor input or ships the anchor as an
additional tool. This RFC does not assume the former is free.

Additions:

| Tool | Notes |
| --- | --- |
| `issue_artifact_embed_token` | Returns the plaintext **once**, following `issueResearchLinkTool`'s `"Participant link (shown only now): …"` convention |
| `revoke_artifact_embed_tokens` | Mirrors `revokeResearchLinksTool` |
| `promote_artifact_comment_to_feedback` | The triage entry point; mirrors the existing `promote_*` family |
| `list_anchored_artifact_comments` | Distinct from `list_comments` only by joining the anchor — arguably an `includeAnchor` flag on the existing tool instead, which maintainers may prefer |

Each needs an entry in `lib/mcp-tool-gates.ts`, which is fail-closed by
construction with a completeness test asserting every registered tool has one —
so these are denied until written. Recommended policy: the two read/promote
tools → `READ` / `WRITE` as appropriate; both **token** tools → `DENY` for
`AGENT` and `AGENT_TURN`. Minting a credential is a human-administrator action,
consistent with `assertWorkspaceAdmin`'s existing refusal.

Two things a reviewer should force us to be explicit about:

- **`applyToolGate` returns early for service actors** (`lib/mcp-tool-gates.ts:656-661`),
  skipping every gate **except one**: `gateInterviewTool(actor, toolName, args)`
  runs *before* the `if (isServiceActor(actor)) return`, so it applies to service
  actors too. The precise claim is therefore "skips all gating except the
  interview gate", and since the interview gate has nothing to say about token
  tools, the practical effect for this RFC is unchanged: a `DENY` for
  `AGENT`/`AGENT_TURN` does not by itself prevent a service actor from minting an
  embed token. Whether that bypass is acceptable for a credential-minting tool is
  a live authorization question and should be answered in Phase 1, not assumed.
- **If a test asserts the refusal, assert on the gate, not the message.**
  `"Human administrator required."` is also thrown by `assertOrgAdminBySlug` and
  `assertScoringModelAccess`, so matching the string alone would not prove which
  gate fired.

---

## Migration from the standalone service

Included because the intent is for Compass to become the long-term home and for
the standalone service to be retired.

| Source concept | Target |
| --- | --- |
| A tracked prototype | `Artifact` (`sourceType: "EXTERNAL_LINK"`), workspace chosen at migration time |
| A hosted prototype page | `Artifact` + `ArtifactRevision` — blocked on Open question 3 |
| A root comment | `Comment` (`targetType: "ARTIFACT"`, `source: "MIGRATION"`) + `ArtifactCommentAnchor` |
| A reply | `Comment` with `parentId` — the same table, one level deep |
| Element selector + re-anchoring fingerprint | `ArtifactCommentAnchor` columns, 1:1 |
| Element screenshot pointer | **Re-upload required.** Private blob pointers in the source store are not portable |
| Resolved flag (boolean) | `Comment.status`: `false → "OPEN"`, `true → "RESOLVED"` — a 1:1 mapping |
| Author identity (OIDC subject + email) | `PortalAccount` matched by email into `CommentExternalAuthor`; name into `Comment.authorName` |

Two honest problems — one fewer than the earlier draft, because two of its three
were artefacts of targeting `FeedbackItem`:

1. **Embed tokens cannot be migrated.** HMAC-signed and hashed-random tokens are
   not interchangeable, and the plaintext of the new scheme exists only at mint
   time. **Every embed snippet on every prototype must be re-issued and
   re-pasted.** This is the operational cost of the cutover and it is not small.
2. **OIDC subject claims do not transfer.** The source service's identity provider
   is not Compass's, so comment ownership ("you may resolve your own comment") is
   re-established by email match, which is weaker than the original subject-claim
   match.

Resolved by the `Comment` target: titles no longer have to be synthesised from
prose (a comment has no title), and the source's `resolved` boolean maps exactly
onto `OPEN`/`RESOLVED` instead of being widened into a six-state lifecycle it
never had.

---

## Phasing

Each phase is independently reviewable and shippable.

| Phase | Contents | Verified by |
| --- | --- | --- |
| **0** | This RFC — agreement on shape | Maintainer review |
| **1** | Schema (all three tables, `source: "WIDGET"`, `artifactFeedbackPublic`, migration `062`, **all three** comment-mutation paths — `deleteComment`, `deleteBrowserComment`, and `createComment`'s rollback — plus `validateExtensions`, `resolveCommentAuthors`, and the preview-automation cascade list), token mint/revoke, embed CORS headers (factoring per the [CORS](#cors) section — maintainers' choice between a shared `lib/cors.ts` and an `EMBED_CORS_HEADERS` constant beside the OAuth one), `GET`/`POST /api/embed/comments`, `route-access` entry | Route-level vitest + `curl`; no UI |
| **2** | The widget script, Shadow DOM UI, anchor rendering, re-anchoring, screenshot capture | Playwright, including an opaque-origin case |
| **3** | In-app surfacing — anchored comments in the existing `artifactComments` panel with page/element/screenshot context and a stale-anchor state; `promote_artifact_comment_to_feedback` | Functional + screenshot E2E, full UI-system checklist |
| **4** | Migration tooling from the standalone service | Dry-run against a copy |

Phase 1 is deliberately useful on its own — an agent can mint a token and read
and write comments over MCP before any widget exists — **but with one honest
qualification**: `add_comment` and `list_comments` accept `targetType: "ARTIFACT"`
today and take no anchor fields, so "POST an *anchored* comment over MCP" needs
Phase 1 to extend those two tools with optional anchor input. Without that, Phase
1's MCP path writes unanchored comments and the anchor arrives with the widget in
Phase 2. Either is a defensible Phase 1 boundary; the RFC should not claim the
stronger one for free.

Phase 3 is materially smaller than in the earlier draft because the panel, the
thread component, and the `PanelId` all already exist.

---

## Alternatives considered

**A. The capture record as a `FeedbackItem` with a `FeedbackPinAnchor`.** This
was the earlier draft's recommendation, and #275 is what changed the answer.
The reasoning then was that a prototype comment needs things `Comment` lacks — a
six-state triage lifecycle, a vote count, an `opportunityId`, a roadmap path —
and that Compass's own copy draws the line at *"Comments are discussion, not
decisions or authorization."*

That argument was right about triage and wrong about *when* triage attaches.
Every one of those needs is real, and all of them are served by
[promotion](#promotion--where-triage-actually-begins) at the moment a human
decides the comment matters. Imposing them at capture time cost: a synthesised
`NOT NULL` title, a `resolved` boolean widened into six states it never had, a
second thread mechanism next to the one #275 just shipped, and a record that
cannot use the `Discussion` component or the `artifactComments` panel. The
earlier draft acknowledged that last cost and accepted it; with artifact
comments now shipped, it is no longer acceptable.

**B. An anchor on `Comment`, but no public write path — in-app only.** Ship
element anchoring for signed-in Compass users and stop there. Much cheaper: no
CORS, no widget, no external identity, no embed token, roughly Phase 1 minus
most of it. Rejected because **it discards the entire point.** The reviewers
whose feedback is worth capturing do not have Compass accounts and are looking
at the prototype, not at Compass. This option delivers the mechanism and
forfeits the motivation. It is, however, the natural fallback if maintainers
reject the cross-origin surface — and worth naming as such rather than
pretending the choice is binary.

**C. A standalone `PrototypeComment` model and its own module.** What the source
service looks like today. Rejected: it duplicates the comment model, the
threading rule, the resolution semantics, the thread UI, and the entire portal
identity stack. `CONTRIBUTING.md` says "Reuse before you build," and this is the
case it was written for.

**D. Keep the service standalone; integrate over MCP or a webhook.** Lowest risk
by a wide margin, and a legitimate outcome of this RFC if maintainers would
rather not own a cross-origin script surface. It forfeits the traceability
argument in Motivation — comments stay orphaned from the tree — but nothing else.

---

## Open questions for maintainers

Genuine forks in the design, not rhetorical.

1. **Screenshot storage and privacy.** `Comment` has **no attachment relation**
   today, so unlike the earlier `FeedbackItem` framing there is no "just reuse
   `FeedbackAttachment`" option — that model's FK is `feedbackItemId`. The
   choices are a small `CommentAttachment` table, a nullable blob pointer on
   `ArtifactCommentAnchor` (one screenshot per anchor is arguably the true
   cardinality), or promotion-time-only attachments. Element screenshots of an
   internal prototype can contain unreleased UI and real customer data, so
   whichever is chosen should be **private**, reached through a
   per-request-authorised route — the private research Blob store via
   `getResearchArtifactStorage()` (`lib/artifact-storage.ts`, backed by
   `RESEARCH_BLOB_READ_WRITE_TOKEN`) is the existing mechanism. The source
   service does serve its equivalent privately, but its own notes record that as
   forced by how its blob store was provisioned rather than chosen on privacy
   grounds — precedent for the mechanism, not an endorsement of the policy.
   There *is* a public-blob precedent on the portal —
   `app/api/portal/.../feedback/upload/route.ts` accepts a 10 MB file to
   `access: "public"` with no identity when `portalAuthRequired` is off and no
   rate limit at all — but it is precedent for user-chosen attachments on a
   public feature request, not for automated captures of an unreleased internal
   prototype, and its lack of any throttle is not a property to copy.
   **Recommendation: nullable pointer on the anchor, private store.**
2. **Should the anchor record `artifactRevisionId` at all?** Recording it gives
   "placed on revision 3" and a reliable stale-anchor signal; omitting it keeps
   the anchor strictly page-plus-element and sits even further from anything the
   User Guide disclaims. **Recommendation: record it, nullable, as provenance
   only** — but this is exactly the clause a maintainer may want drawn
   differently, and the column is trivially droppable.
3. **Does Compass want to host uploaded prototype HTML** (the source service offers
   this; this RFC deliberately does not)? It implies serving arbitrary third-party
   HTML from a Compass origin, which the source service handles with a separate
   share origin plus a
   CSP sandbox — and that sandbox is what creates the opaque-origin screenshot
   problem above. **Recommendation: defer; `EXTERNAL_LINK` only in Phase 1.**
4. **Identity for widget writes: reuse `portalAuthRequired`, or require
   identity always?** This is the question this RFC has been least stable on, so
   here is the full state of it rather than a recommendation alone.

   The earlier draft recommended "identity required by default". A middle draft
   reversed that to "anonymous by default", on two grounds — that anonymous
   submission is already the shipped portal default with an existing
   per-workspace knob, and that the anonymous path is the only one needing no new
   cross-origin identity machinery, since `compass_portal_session` is
   `SameSite=Lax` and cannot reach a cross-origin widget at all.

   Both of those grounds still hold. But that draft also justified the reversal
   by asserting anonymity was "precisely the source service's model", and **that was
   wrong** — the source service refuses to post without a signed-in identity (see
   [What already exists](#what-already-exists-the-reuse-case)). So the appeal to
   the source service's behaviour actually points the *other* way, and the entire
   nonce/popup/single-use-claim apparatus in the source service exists because it paid the
   cost of cross-origin identity deliberately.

   What survives, stated honestly:

   - **Anonymous is cheaper, and is already Compass's shipped default** for
     comparable public writes. `portalAuthRequired = false` is more permissive
     than the source service has ever been.
   - **Identified-but-not-a-member is what the source service actually does**, and
     `portalAuthRequired = true` with portal magic link or SSO is its direct
     analogue — no Compass account, no workspace seat, but a verified email and
     the authoritative-email anti-spoof rule.
   - **The `SameSite=Lax` constraint is the real cost driver**, and it applies to
     whichever of the two requires identity. It is the reason the source service's handoff
     exists and the reason this is not a one-line toggle.

   **Recommendation: honour `portalAuthRequired` unchanged and ship the anonymous
   path first**, because it needs no new identity transport and it is the mode
   that makes the feature adoptable. But this is explicitly a recommendation
   about *sequencing*, not a claim that anonymity is the truer model — the
   identified path is what the source service chose after contact with real users,
   and a maintainer who wants it mandatory from the start is choosing the
   better-evidenced default, at the cost of building the bearer-token exchange in
   Phase 1 rather than later. A per-artifact override is a possible refinement; it
   is not needed for Phase 1 either way.
5. **Is `Artifact` the right subject?** It fits well — revisions, `ArtifactLink`
   to `SOLUTION`, `HTML_UPLOAD | EXTERNAL_LINK`, `externalUrl` already present,
   and #275 already put comments on it — but it was designed as a
   decision-support deliverable, and this adds a long-lived public write path to
   it. **Recommendation: yes for Phase 1** — the alternative is a new subject
   type, which costs a registry entry and buys nothing until something other than
   an artifact needs element anchors. If the deliverable framing later proves
   load-bearing, the anchor table is keyed on the comment, not the artifact, so
   moving the subject is a migration rather than a redesign.

## Risks

- **A new public, unauthenticated-by-session, CORS-enabled write endpoint** is
  the largest item here and it is a real widening of the attack surface.
  Mitigations: `artifactFeedbackPublic` **off by default**, token → artifact →
  workspace scoping, per-token rate-limit counters, no `Allow-Credentials`,
  `portalAuthRequired` respected unchanged, and `normalizeResearchAppUrl` reused
  for any stored external URL.
- **Anonymous writes invite spam**, and this is the honest cost of the feature's
  core value. The per-token counters are the first line; revoking a single
  snippet is the second. A workspace that cannot tolerate it sets
  `portalAuthRequired`.
- **The widget will be the least idiomatic code in the repository** — vanilla JS,
  no bundler, no React, no design tokens. Inherent to shipping a script to a page
  you do not control, but a permanent maintenance asymmetry.
- **Cross-origin *identified* review is the hard part, and the source service
  proves it by having paid for it.** The source service's full solution — a nonce handed to
  a first-party popup, the token deposited server-side, then claimed single-use
  via a once-a-second poll — exists for two compounding reasons: its writes
  require an identity at all, and its hosted prototype pages run under a sandbox
  CSP, which puts the widget on an **opaque origin** where `localStorage` throws,
  `window.opener` is severed outright by `Cross-Origin-Opener-Policy`, and a
  *targeted* `postMessage` has no origin to target. A cookie fails for a
  **separate** reason that applies on every origin, opaque or not: the widget's
  cross-origin fetches never set `Access-Control-Allow-Credentials`, so credentials
  are never sent. Three distinct
  mechanisms, one symptom — worth keeping apart, because only the first is fixed by
  deferring `HTML_UPLOAD`. Deferring
  `HTML_UPLOAD` (Open question 3) removes the opaque-origin half. Shipping the
  anonymous path first (Open question 4) defers the other half, but **does not
  eliminate it** — any workspace that later sets `portalAuthRequired` needs the
  bearer-token exchange, because `SameSite=Lax` means the portal cookie can never
  reach the widget. **Questions 3 and 4 are coupled, and answering both
  conservatively shrinks this risk substantially — but it is deferred, not
  designed away.**
- **Adding a `source` member is a wider blast radius than it looks.** Any
  exhaustive `switch` on `CommentSource`, any UI that renders a source badge, and
  any test asserting the union's members will need updating. It is still the
  right axis; it is not free.
- **Async index builds on DSQL** mean the existing comment queries must not
  regress while `062` builds.

## Appendix — provenance

**About the source service, and why it is not named or linked.** The prior art
behind this RFC is an internally-deployed commenting service in a **private**
repository. It is referred to throughout as "the source service" and is not cited
by file or line, deliberately: a citation a maintainer cannot open is not
evidence, and publishing one into a public repository discloses a closed codebase
without making this document any more checkable. Where a source-service claim
matters to a decision here, it is stated as a described behaviour and a lesson,
and the corresponding *Compass* claim — which you can verify — is cited precisely.

Its relevant shape: Next.js 16 App Router, raw-SQL migrations on Aurora DSQL, a
hosted OIDC identity provider, and object storage for uploads. It shares Compass's
database engine, which is why its failure modes under DSQL transfer directly and
are the most load-bearing thing this RFC carries over.

**Size**, to the nearest order of magnitude: tens of thousands of lines of
TypeScript, roughly half of it tests. A more precise figure would not help you —
you cannot open the repository to check it — so none is given. Earlier drafts of
this document quoted exact line counts; they were wrong twice in identical ways,
which is a fair illustration of why an uncheckable number is worse than no number.

This RFC carries over its
**behavioural findings** — element re-anchoring by document-relative ratios, the
iframe/opaque-origin rasteriser constraint, the `window.origin` detection
subtlety, the no-`Allow-Credentials` rule, the `text/plain` preflight avoidance
(still live on polls, vestigial on writes) — while mapping its data model onto
Compass primitives rather than importing it. Where Compass had already reached a
better answer than the source service, Compass wins: the wildcard-origin CORS
shape in `lib/oauth/http.ts` supersedes the source service's echoed origin, and
`Comment` supersedes its standalone comment table.

### Review history, stated precisely

Every claim about either codebase was checked against source rather than
recalled. The audit trail matters here because this document has been wrong about
its own audit trail, so it is laid out plainly:

1. **An adversarial pass over the *pre-first* draft** — briefed to refute rather
   than confirm — found 18 inaccuracies across 112 claims, all corrected before
   the first draft. Notable: a named blob store that did not exist, two "modelled
   exactly on X" claims that overstated their precedents, an unsupported "90%
   done" figure, a CORS rationale describing a configuration browsers already
   reject, and two places where a stated non-goal contradicted an open question.
   **Correction to the previous draft's account of this**: it described those 18
   findings as a pass over "the first draft". It was a pass over the draft
   *before* it. It also listed "LOC and spec counts that were wrong" among the
   corrected items, which was false — those figures shipped unchanged into both
   subsequent drafts and are only now re-measured above.
2. **A second sweep** caught a nineteenth error the adversarial pass had missed
   (the CORS claim, below).
3. **A third adversarial pass over the reworked draft** found 21 further findings
   across 138 claims, two of them blocking. All 21 were corrected.
4. **A fourth adversarial pass, scoped to the sections the third pass had just
   rewritten**, found 16 more across ~135 claims — three blocking — including two
   errors *introduced by* the third pass's own corrections. Every one was
   re-verified against source before being applied.
5. **A fifth pass, scoped in turn to what the fourth had just rewritten**, found
   **four** more — a wrong line range, a property attributed to the wrong
   function, a miscount that contradicted the appendix, and an overstated
   paraphrase. None had a correctness consequence. This draft is the result. All
   three lists are below, because a reviewer is owed them rather than an assurance.

The fourth and fifth passes are the load-bearing entries in that list, because each
was told the previous findings had been corrected and each still found defects *in
the corrections*. The honest conclusion is not that the document is now clean but
that **the error rate is falling and has not reached zero**: 18, 1, 21, 16, 4,
with the last round producing nothing that would have caused a data defect. A
sixth pass should be assumed to find something.

The nineteenth finding, and the reason the invitation at the end of this section
is sincere rather than rhetorical:

- **"No CORS anywhere in the repository. Zero `Access-Control-*` headers, zero
  `OPTIONS` handlers" was false.** `lib/oauth/http.ts` exports
  `OAUTH_CORS_HEADERS` and seven routes export `OPTIONS`. The error mattered in
  two directions: it overstated the feature's cost by claiming a mechanism had
  to be built from nothing, and it caused the first draft to propose an
  **echoed-origin** helper when the house pattern is a safer wildcard. The
  correct claim is narrower and still supports the RFC: no *portal* or
  *research* route has CORS, and two research routes enforce same-origin
  explicitly.
- The first draft's Open question 4 asserted identity should be required by
  default without noting that `compass_portal_session` is `SameSite=Lax` and
  therefore **cannot reach a cross-origin widget at all** — which makes the
  anonymous path not merely acceptable but structurally the cheaper one.
- The first draft described the portal as supporting anonymous submission but did
  not identify `workspace.portalAuthRequired` as the existing per-workspace knob,
  nor the authoritative-email anti-spoof rule that accompanies it. Both are
  reused here rather than reinvented.
- The first draft presented the iframe/opaque-origin rasteriser constraint purely
  as an import from the source service, without noting that
  `ARTIFACT_IFRAME_SANDBOX` is already `"allow-scripts"` without
  `allow-same-origin`, so **Compass's own artifact preview already has this
  property.**

### What the third pass found

Listed so a reviewer can check the corrections rather than trust them. Two were
blocking:

- **The proposed migration number was already taken — twice.** The previous draft
  claimed `055` was "next free … and a fresh one" and contrasted it with "not a
  second `054`". Both halves were false: `055` already has two occupants and `054`
  already has three, so the proposal would have created a *third* `055` — the exact
  outcome the sentence claimed to avoid. Next genuinely free **was `059`** when this
  pass ran; three migrations landed in the eleven days before the sixth pass and it
  is now `062` — see [the sixth pass](#what-the-sixth-pass-found). The duplicate list
  was also incomplete (it omitted 054 and 055). The corrected list the third pass
  then wrote was itself wrong in the other direction — it added `009`, which is not a
  duplicate at all; see the fourth-pass list.
- **Five of the seven named MCP comment tools do not accept `targetType` at all.**
  Only `add_comment` and `list_comments` take `commentTargetSchema`; the other five
  are `commentId`-keyed. This weakened the Phase 1 "an agent can drive this over
  MCP" claim, now qualified in [Phasing](#phasing).

The rest, grouped:

- **Fabricated or wrong citations.** `lib/mcp/tools/*` does not exist (MCP modules
  are flat `lib/mcp-*.ts` plus `app/api/mcp/route.ts`). The quoted portal-feedback
  route carried an inline comment (`// authoritative — client value ignored`) that
  is not in the source. `Discussion`/`DocPanelShell` nesting was inverted. The
  "closed union of four field names" is in `portal-settings-panel.tsx:52`, not
  `actions.ts`, which uses per-field conditional spreads instead.
- **Wrong counts.** `ResearchParticipantToken` has ten throttling columns across
  five window/count pairs, not eight across four. `PortalSession` has **no
  `revokedAt`** and was cited twice as a revocation precedent. The new-table count
  was stated three different ways. The widget route's size was understated. LOC and
  spec figures were wrong and byte-identical to the previous draft.
- **Two `text/plain` claims reversed.** It *is* on a source-service poll path
  (the sign-in handoff), and it does *not* stop paying on writes for the reason
  given — the source service's writes are never anonymous, so the identity header is always
  present. Compass's anonymous-write case is the one where it genuinely helps, which
  the previous draft had backwards.
- **A claimed cascade list that does not exist — in `delete-workspace-cascade.ts`.**
  That file deletes no `Comment`, `DocCommentAnchor`, or `SolutionPlanProposal`
  rows. The third pass was right about the file and wrong about the conclusion it
  drew: a workspace-level comment cascade does exist, just elsewhere. See the
  fourth-pass list.
- **Promotion copied `submitterName` from `CommentExternalAuthor`**, which
  deliberately has no name column. It comes from `Comment.authorName`.
- **An unsupported performance claim** ("one indexed lookup per request") is now
  stated as a design precedent rather than a measurement.
- **Naming and idiom overstated.** Only `roadmapPublic` follows `<surface>Public`;
  `feedbackEnabled` does not, so there was no idiom to follow. The `comments`
  indexes carry no explanatory comments, so calling them "deliberately-reasoned"
  overstated what the source shows.
- **A hard-coded `lib/cors.ts`** in Phasing contradicted the CORS section, which
  deliberately leaves the factoring to maintainers.

And one finding the pass did not make, surfaced while checking it — **the most
consequential correction in this draft**:

- **The previous draft asserted that anonymous submission was "precisely
  the source service's model". It is not.** Its comment-submit handler refuses
  without a session and every comment write carries its identity header. The
  source service requires an identity to comment; what it does not require is
  workspace membership. This mattered because the reversal of Open question 4 from
  "identity required" to "anonymous by default" rested partly on that false
  premise. The recommendation still stands on its other grounds, but it is now
  framed as a sequencing choice rather than fidelity to the source service, and
  Motivation now says *membership* where it used to say *account*.

### What the fourth pass found

Scoped to the sections the third pass had just rewritten — which is why it caught
regressions the earlier passes could not have. Three were blocking, and **two of
those three were introduced by the third pass's own corrections.**

Blocking:

- **A fabricated *absence*, which is the harder kind to catch.** The third pass
  removed an inline comment it could not find in the portal-feedback route, and
  then added a parenthetical asserting the route "carries no inline comment saying
  so". The route documents the anti-spoof rule explicitly at `:145-148`. Deleting a
  misquote is correct; asserting nothing is there is a new false claim, and it made
  the RFC read as though it had found an undocumented behaviour when it had found a
  documented one.
- **`PortalSession` cited a third time, now as a *counter* precedent.** The third
  pass fixed the revocation misattribution and then leaned on `PortalSession` for
  the rate-limit-counters-on-the-token-row pattern, which it does not have — in a
  paragraph whose next sentence calls `lib/research-session.ts` the **only**
  durable rate limit in Compass. Self-contradictory within two sentences. Shape
  comes from both tables; `revokedAt` and counters come from
  `ResearchParticipantToken` alone.
- **"The one function that must be extended" is two functions.**
  `deleteBrowserComment` in `lib/comment-browser.ts:85-117`, reached from
  `app/api/comments/[id]/route.ts:44`, is a second per-comment delete path — and
  it is the one the in-app thread UI uses. A reviewer deleting a widget comment
  through the UI would have orphaned both new extension rows. This is the only
  fourth-pass finding that would have caused a real data defect if implemented as
  written. Checking it surfaced a further asymmetry the RFC now raises: the UI path
  is transactional with a P2034 retry and the MCP path is four bare sequential
  deletes.

Moderate:

- **A workspace-level comment cascade *does* exist**, at
  `lib/preview-automation/service.ts:30-33` — anchors, proposals, `parentId`
  null-out, then comments — so "there is no existing list" was wrong and the new
  tables do join one. The real finding is an asymmetry: the list lives in the
  preview-automation teardown rather than in `delete-workspace-cascade.ts`, so
  every *other* caller still leaves comments behind.
- **`notFound()` is not the precedent.** There is no `notFound()` call anywhere
  under `app/portal`. `roadmap/page.tsx:46-52` returns **200** with an
  `EmptyState`, which is a deliberately different and better behaviour for a
  visitor holding a legitimate link.
- **`009` is not a duplicate prefix.** The second filesystem entry is a stray
  `prisma/migrations/009_feedback_voting.sql` the `MIGRATIONS` array never
  references — dead weight, not a tolerated collision. Eight duplicate prefixes,
  not nine.
- **The quoted two-line mint snippet appears in neither cited file.** Both wrap
  the digest in a named helper (`hashResearchToken`, `hashToken`). The RFC now
  proposes a third helper beside them instead of quoting a hybrid that exists
  nowhere.
- **The re-measured LOC figure was still wrong** — an arithmetic error inside the
  very table an earlier pass had re-measured from scratch precisely to stop this
  recurring. The figures are gone entirely now: see the [appendix](#appendix--provenance)
  for why an uncheckable number is worse than none.
- **The widget is not the largest file "by a wide margin".** A lockfile is larger,
  and among hand-written files the margin over the next largest is about 16% — not
  the order of magnitude the phrase implied.

Minor: four settings siblings, not three; "no registry change" bolded on a cell
that does widen `CommentSource`; `applyToolGate` runs `gateInterviewTool` *before*
its service-actor early return, so it skips all gating *except* that one;
the source service's extracted position module is a counter-example to the
extraction seam rather than a second instance of it, by its own docstring; its CORS
helper already falls back to `*` for opaque origins with the same never-credentials
rationale, so the CORS disagreement is narrower than claimed; "every write carries
the identity header" is true of comment writes but false of the sign-in poll, which
is a `POST` sent with no identity header at all; and the four-route API table
silently dropped the source service's reviewer self-`DELETE`, now an explicit and
argued omission.

### What the fifth pass found

Scoped, like the fourth, to the text its predecessor had just written. It found
**four** defects in ~10 rewritten sections, none with a data-correctness
consequence — the first real sign of convergence, since the fourth pass's blocking
findings included one that would have orphaned rows in production. All four:

- **A line range that truncated away the behaviour it was cited for.**
  `deleteBrowserComment` was given as `lib/comment-browser.ts:83-104` in two
  places. `:104` is where the *transaction callback* closes; the function runs to
  `:115`, and the 3-attempt P2034 retry loop the RFC describes sits at `:105-114`
  — entirely outside the range a reviewer was told to open. Now `:83-115`, with the
  transaction body and retry loop cited separately.
- **"the write helper always attaches the identity header" is false of that
  helper.** It attaches the header only when a session exists, and the widget's
  delete path calls it with no sign-in precondition at all. The "always" is a
  property of the *comment-submit call site*, which early-returns unless signed in. The
  conclusion about preflights is unaffected; the mechanism was attributed to the
  wrong layer.
- **"Four sequential un-wrapped `prisma` calls" miscounted, and contradicted this
  appendix.** `deleteComment` makes six calls, four of them deletes, two of the
  six conditional on thread-root status. The appendix had it right ("four bare
  sequential *deletes*") while the table two-thirds of the way up the document had
  it wrong — an internal disagreement on the noun.
- **An overstated paraphrase, in a sentence crediting the source service.** Its
  own note says browsers are *inconsistent about accepting* a literal
  `Access-Control-Allow-Origin: null`, and that several recent versions reject it
  outright; the RFC had flattened that to "browsers reject" it. Hardening someone
  else's hedge makes an agreement look tighter than they claimed it was.

The pass also re-derived every LOC figure, re-enumerated the eight duplicate
migration prefixes, re-confirmed the zero-match absence claims (`notFound()` under
`app/portal`, `Access-Control-Allow-Credentials` repo-wide), and checked the nine
other rewritten sections clean.

### What the sixth pass found

Eleven findings, two blocking. This was the first pass to run against a **moved**
`upstream/main` — fifteen commits and 295 files had landed since the fifth — and the
two blocking findings are a direct consequence of that. One of them the document had
already fixed once.

- **BLOCKING: the migration number was taken again.** The third pass moved it from
  `055` to `059`; `059_geode_document_storage`, `060_workspace_updates`, and
  `061_product_analytics` all landed in the interval. Now `062`, with an explicit
  instruction to re-check at merge time rather than trust the number — see
  [DSQL obligations](#dsql-obligations). Twice-wrong is enough to conclude the claim
  cannot be verified once and trusted.
- **BLOCKING: there is a third comment-mutation path, and this RFC is what makes it
  dangerous.** The fourth pass found the second (`deleteBrowserComment`). The third
  is `createComment`'s compensating rollback (`lib/comments.ts:121-127`), which
  deletes the comment and no extension row. It is safe today only because
  `validateExtensions` (`:82-90`) makes the two existing extensions mutually
  exclusive by target type. This RFC proposes two extensions on the *same* `ARTIFACT`
  comment, which removes that guarantee and turns the rollback into an orphan
  producer — in the non-transactional modes of `withWorkspaceUpdates`
  (`lib/workspace-updates-capture.ts:95-108`) only, which makes it
  environment-dependent and therefore the kind of defect that passes review. This is
  the third consecutive pass to find an Nth code path where the document claimed
  N−1.
- **A fourth rate-limit implementation, and they disagree with each other.** The RFC
  named `lib/research-session.ts` as "the only" durable rate limit and said to copy it
  "verbatim, including its retry semantics". There are four implementations of the
  counter-column pattern, and the one closest to this RFC's two-pair shape
  (`lib/research-participant-voice.ts:38-48`) deliberately does *not* retry. The
  reviewer found three of the four; the fourth
  (`lib/research-voice-operations.ts:336-364`, on `ResearchVoiceCall`) was found while
  checking the reviewer's own count — the same Nth-path failure, one level up.
- **Three line-number citations had drifted**, all correct when written:
  `prisma/schema.prisma:163-164` (the flags are now at `:199-200`; that citation now
  points at `@@map("authenticators")`), `app/api/mcp/route.ts:262-269`
  (`commentTargetSchema` is at `:264`), and `lib/mcp-tool-gates.ts:638-646`
  (`applyToolGate` is at `:656`). Schema citations are now by field name, which does
  not rot. The MCP citation dragged seven more with it: the
  [MCP surface](#mcp-surface) section numbers all seven comment tools relative to
  `commentTargetSchema`, so every one of them was off by two. That was caught by a
  mechanical sweep of all 46 cited locations *after* the reviewer's findings were
  applied, not by the reviewer — a reviewer given a wrong anchor tends to check the
  anchor and not the chain hanging off it.
- **A cited range that excluded the thing it described.**
  `settings/actions.ts:872-886` was given for "an input type of four optional
  booleans"; the input type is at `:861-866` and the range ran fourteen lines into an
  unrelated function. Now `:858-881`. Same class of error as the fifth pass's
  `:83-104`.
- **Four internal links were dead** — em dashes in headings produce a *double* hyphen
  in GitHub's anchor slug, and the RFC wrote single. Two distinct targets, four link
  sites.
- **Three mechanisms conflated into one.** "An opaque origin where `localStorage`,
  cookies, and targeted `postMessage` all fail" merged three separate causes: the
  opaque origin (whose own documented failure list does not mention cookies at all),
  COOP severing `window.opener`, and the never-set `Allow-Credentials` that blocks
  cookies on *every* origin, opaque or not. Only the
  first is fixed by deferring `HTML_UPLOAD`, so the merge obscured what the deferral
  actually buys.
- **`validateExtensions` and `resolveCommentAuthors` were never named**, though the
  design requires changing the first and depends on the second's exact filter
  condition. `resolveCommentAuthors` (added by #288, three days before this pass) now
  runs on every comment read and rewrites `authorName` — harmlessly for widget
  comments, but only because of a null-`authorId` check the RFC had not noticed it was
  relying on.
- Plus a missing `onDelete`/`onUpdate` note on the proposed `artifact` relation (the
  omission is right, the silence about it was not), a citation stopping one line short
  of the `JSON.parse` it was given for, and one omission that *strengthens* the RFC:
  the source service has since reached the same hashed-token-over-HMAC conclusion in
  its own newest credential, which the RFC now says outright.

The pass also re-derived every LOC figure, re-enumerated the eight duplicate
migration prefixes, re-confirmed the zero-match absence claims, verified all three
`"Human administrator required."` sites and both existing extension tables, and
checked roughly 215 distinct claims in total. It did **not** execute the proposed DDL
against a DSQL cluster, and did not render the document on GitHub to confirm the
anchor fix.

### The trend, stated honestly

18 findings, then 1, then 21, then 16, then 4, then 11. It is **not** converging
monotonically, and the sixth pass is the reason to stop believing it would: two of its
blocking findings exist because the target repository moved, not because the document
was wrong when written. A document that cites another project by line number has a
shelf life measured in days.

Three consecutive passes have now found an Nth code path where the document claimed
N−1 — `deleteBrowserComment` (fourth), the `deleteComment` call-shape disagreement
(fifth), `createComment`'s rollback plus a fourth rate limiter (sixth). That is a
pattern, not bad luck, and it is the specific thing a maintainer should be most
sceptical of in this document. **If you read one section adversarially, make it
[DSQL obligations](#dsql-obligations).**

If you find a further error, that is the review working as intended — please flag it.
