/**
 * The searchParam contract for the Feedback grid.
 *
 * Pure module — no React, no Prisma client, no I/O. Both the server page and
 * the client-side URL writer import it so they cannot disagree about what a
 * URL means.
 *
 * Hard rules:
 *  - **Every value is allowlist-validated.** Hostile or malformed input
 *    silently falls back to the default. This module never throws, never
 *    signals a 400, and never lets a raw request string reach Prisma.
 *  - Repeated `status` params are a multi-select; every other repeated param
 *    is normalised by taking the **last** value.
 *  - **Every `orderBy` ends with `{ id: "asc" }`.** `status`, `type` and
 *    `voteCount` are non-unique, so without a unique tiebreak `skip`/`take`
 *    silently duplicates and drops rows across pages.
 */

import type { Prisma } from "@prisma/client";
import {
  isFeedbackStatus,
  isFeedbackType,
  FEEDBACK_STATUSES,
  type FeedbackStatus,
  type FeedbackTypeValue,
} from "@/lib/feedback-meta";

// ---------------------------------------------------------------------------
// Contract constants
// ---------------------------------------------------------------------------

/** Public sort keys. These are URL vocabulary, deliberately not column names. */
export const FEEDBACK_SORT_KEYS = [
  "title",
  "status",
  "type",
  "votes",
  "created",
] as const;

export type FeedbackSortKey = (typeof FEEDBACK_SORT_KEYS)[number];

/** URL sort key -> Prisma column. The only place a sort string becomes a column. */
const SORT_KEY_COLUMN = {
  title: "title",
  status: "status",
  type: "type",
  votes: "voteCount",
  created: "createdAt",
} as const satisfies Record<FeedbackSortKey, string>;

/** Direction a column sorts when first selected (recency/score sort desc). */
const SORT_KEY_DEFAULT_DIR = {
  title: "asc",
  status: "asc",
  type: "asc",
  votes: "desc",
  created: "desc",
} as const satisfies Record<FeedbackSortKey, SortDirection>;

export type SortDirection = "asc" | "desc";

export const FEEDBACK_SORT_DIRECTIONS = ["asc", "desc"] as const;

export const FEEDBACK_PAGE_SIZES = [25, 50, 100] as const;

export type FeedbackPageSize = (typeof FEEDBACK_PAGE_SIZES)[number];

export const DEFAULT_FEEDBACK_PAGE_SIZE: FeedbackPageSize = 25;

/** Upper bound on `page`, so a hostile offset cannot force a huge `skip`. */
export const MAX_FEEDBACK_PAGE = 10_000;

/** Longer search strings are truncated, not rejected. */
export const MAX_FEEDBACK_Q_LENGTH = 100;

/** Shorter search strings are ignored (a 1-char `contains` matches everything). */
export const MIN_FEEDBACK_Q_LENGTH = 2;

/** What Next passes to a page as `searchParams`. */
export type FeedbackSearchParams = Record<
  string,
  string | string[] | undefined
>;

/** A fully validated query. Every field is safe to hand to Prisma. */
export type FeedbackQuery = {
  /** Trimmed, capped, and at least `MIN_FEEDBACK_Q_LENGTH` long, else `null`. */
  q: string | null;
  status: FeedbackStatus[];
  type: FeedbackTypeValue | null;
  /** `null` means "the default ordering", which is not a single column. */
  sort: FeedbackSortKey | null;
  dir: SortDirection;
  /** 1-based, clamped to `1..MAX_FEEDBACK_PAGE`. */
  page: number;
  per: FeedbackPageSize;
};

/** The query a bare `/feedback` URL means. */
export const DEFAULT_FEEDBACK_QUERY: FeedbackQuery = {
  q: null,
  status: [...FEEDBACK_STATUSES],
  type: null,
  sort: null,
  dir: "desc",
  page: 1,
  per: DEFAULT_FEEDBACK_PAGE_SIZE,
};

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Collapse `string | string[] | undefined` to a single string.
 * A repeated param wins with its **last** value; anything else yields `null`.
 */
function lastValue(raw: string | string[] | undefined): string | null {
  if (Array.isArray(raw)) {
    for (let i = raw.length - 1; i >= 0; i -= 1) {
      const candidate = raw[i];
      if (typeof candidate === "string") return candidate;
    }
    return null;
  }
  return typeof raw === "string" ? raw : null;
}

/** Read one param from either a plain object or a `URLSearchParams`. */
function readParam(
  source: FeedbackSearchParams | URLSearchParams,
  key: string,
): string | null {
  if (typeof URLSearchParams !== "undefined" && source instanceof URLSearchParams) {
    const all = source.getAll(key);
    return all.length > 0 ? (all[all.length - 1] ?? null) : null;
  }
  // Guard against prototype-pollution style keys reaching us as own-property
  // lookups on an object we did not build.
  if (!Object.prototype.hasOwnProperty.call(source, key)) return null;
  return lastValue((source as FeedbackSearchParams)[key]);
}

/** Read every value of a repeated param from either supported input shape. */
function readParams(
  source: FeedbackSearchParams | URLSearchParams,
  key: string,
): string[] {
  if (typeof URLSearchParams !== "undefined" && source instanceof URLSearchParams) {
    return source.getAll(key);
  }
  if (!Object.prototype.hasOwnProperty.call(source, key)) return [];
  const raw = (source as FeedbackSearchParams)[key];
  if (Array.isArray(raw)) return raw.filter((value): value is string => typeof value === "string");
  return typeof raw === "string" ? [raw] : [];
}

/**
 * Strict non-negative decimal integer. Deliberately rejects `"1e9"`, `"0x10"`,
 * `"1.5"`, `" 3"`, `"-1"` and `"Infinity"` — `Number()` would accept several of
 * those and produce a nonsense offset.
 */
function parsePositiveInt(raw: string | null): number | null {
  if (raw === null || !/^\d{1,10}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Validate raw search params into a `FeedbackQuery`.
 * Never throws: any unrecognised value falls back to its default.
 */
export function parseFeedbackQuery(
  source: FeedbackSearchParams | URLSearchParams | null | undefined,
): FeedbackQuery {
  if (!source) return { ...DEFAULT_FEEDBACK_QUERY };

  // q: trim, cap, then require a useful minimum length.
  const rawQ = readParam(source, "q");
  let q: string | null = null;
  if (rawQ !== null) {
    const trimmed = rawQ.trim().slice(0, MAX_FEEDBACK_Q_LENGTH).trim();
    q = trimmed.length >= MIN_FEEDBACK_Q_LENGTH ? trimmed : null;
  }

  // status: repeated, independently allowlisted values. Canonical ordering
  // makes equality and shareable URLs deterministic. No valid selection means
  // the default (all statuses), including malformed URLs.
  const requestedStatuses = new Set(readParams(source, "status").filter(isFeedbackStatus));
  const status = requestedStatuses.size > 0
    ? FEEDBACK_STATUSES.filter((value) => requestedStatuses.has(value))
    : [...FEEDBACK_STATUSES];

  const rawType = readParam(source, "type");
  const type = isFeedbackType(rawType) ? rawType : null;

  // sort: fixed key table. An unknown key means "use the default ordering".
  const rawSort = readParam(source, "sort");
  const sort =
    rawSort !== null &&
    (FEEDBACK_SORT_KEYS as readonly string[]).includes(rawSort)
      ? (rawSort as FeedbackSortKey)
      : null;

  // dir: only meaningful alongside a sort key; otherwise the default ordering
  // owns its own directions.
  const rawDir = readParam(source, "dir");
  const dir: SortDirection =
    rawDir === "asc" || rawDir === "desc"
      ? rawDir
      : sort
        ? SORT_KEY_DEFAULT_DIR[sort]
        : DEFAULT_FEEDBACK_QUERY.dir;

  // per: closed set of page sizes.
  const rawPer = parsePositiveInt(readParam(source, "per"));
  const per = (FEEDBACK_PAGE_SIZES as readonly number[]).includes(rawPer ?? -1)
    ? (rawPer as FeedbackPageSize)
    : DEFAULT_FEEDBACK_PAGE_SIZE;

  // page: 1-based and clamped. 0 and anything unparseable fall back to 1.
  const rawPage = parsePositiveInt(readParam(source, "page"));
  const page =
    rawPage === null || rawPage < 1
      ? 1
      : Math.min(rawPage, MAX_FEEDBACK_PAGE);

  return { q, status, type, sort, dir, page, per };
}

// ---------------------------------------------------------------------------
// Prisma builders
// ---------------------------------------------------------------------------

/**
 * The `where` for both `findMany` and `count`. Call this once and pass the same
 * object to both so the page contents and the total can never disagree.
 */
export function buildFeedbackWhere(
  query: FeedbackQuery,
  workspaceId: string,
): Prisma.FeedbackItemWhereInput {
  const where: Prisma.FeedbackItemWhereInput = { workspaceId };
  if (query.status.length < FEEDBACK_STATUSES.length) {
    where.status = { in: query.status };
  }
  if (query.type) where.type = query.type;
  if (query.q) {
    where.OR = [
      { title: { contains: query.q, mode: "insensitive" } },
      { description: { contains: query.q, mode: "insensitive" } },
    ];
  }
  return where;
}

/**
 * `orderBy` for the query. Always ends with `{ id: "asc" }`.
 *
 * With no explicit sort this reproduces the pre-grid ordering exactly:
 * `voteCount desc, createdAt desc`.
 */
export function buildFeedbackOrderBy(
  query: FeedbackQuery,
): Prisma.FeedbackItemOrderByWithRelationInput[] {
  if (!query.sort) {
    return [{ voteCount: "desc" }, { createdAt: "desc" }, { id: "asc" }];
  }
  const column = SORT_KEY_COLUMN[query.sort];
  return [
    { [column]: query.dir } as Prisma.FeedbackItemOrderByWithRelationInput,
    { id: "asc" },
  ];
}

/** `skip` for the current page. */
export function feedbackSkip(query: FeedbackQuery): number {
  return (query.page - 1) * query.per;
}

/** `take` for the current page. */
export function feedbackTake(query: FeedbackQuery): number {
  return query.per;
}

/** Total page count for a server-reported total; always at least 1. */
export function feedbackPageCount(query: FeedbackQuery, total: number): number {
  if (total <= 0) return 1;
  return Math.max(1, Math.ceil(total / query.per));
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/**
 * A patch applied on top of a current query. `null` clears a value.
 * `page` is included so a pagination control can move pages, but any change to
 * a filter, sort or page size overrides it back to page 1 (see below).
 */
export type FeedbackQueryPatch = Partial<{
  q: string | null;
  status: readonly (FeedbackStatus | string)[] | FeedbackStatus | string | null;
  type: FeedbackTypeValue | string | null;
  sort: FeedbackSortKey | string | null;
  dir: SortDirection | string | null;
  page: number | null;
  per: number | null;
}>;

/** Keys that invalidate the current offset when they change. */
const PAGE_RESETTING_KEYS = ["q", "status", "type", "sort", "dir", "per"] as const;

function queryValuesEqual(
  left: FeedbackQuery[keyof FeedbackQuery],
  right: FeedbackQuery[keyof FeedbackQuery],
): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return left === right;
}

/**
 * Apply `patch` to `current` and produce the params for the next URL.
 *
 * Two invariants are enforced **here**, not in callers:
 *  1. Any change to a filter, sort or page size resets `page` to 1. Page 3 of
 *     an old filter is meaningless under a new one.
 *  2. Values equal to the default are omitted, so a cleared grid produces a
 *     bare URL rather than a trail of `?page=1&per=25&dir=desc`.
 *
 * The patch is re-validated through `parseFeedbackQuery`, so a caller cannot
 * smuggle an unvalidated string into the URL either.
 */
export function serializeFeedbackQuery(
  current: FeedbackQuery,
  patch: FeedbackQueryPatch = {},
): URLSearchParams {
  // A `sort` patch with no explicit `dir` means "the user clicked a header":
  // use the new column's natural direction, or flip if it is already active.
  // Carrying the previous column's direction over would be a stale read.
  const impliedDir =
    "sort" in patch && patch.dir === undefined
      ? patch.sort !== null &&
        patch.sort !== undefined &&
        (FEEDBACK_SORT_KEYS as readonly string[]).includes(patch.sort)
        ? nextSortDirection(current, patch.sort as FeedbackSortKey)
        : undefined
      : undefined;

  // Re-validate the merged result rather than trusting the patch.
  const merged = parseFeedbackQuery({
    q: patch.q !== undefined ? (patch.q ?? undefined) : (current.q ?? undefined),
    status:
      patch.status !== undefined
        ? (typeof patch.status === "string"
            ? patch.status
            : patch.status
              ? [...patch.status]
              : undefined)
        : current.status,
    type:
      patch.type !== undefined
        ? (patch.type ?? undefined)
        : (current.type ?? undefined),
    sort:
      patch.sort !== undefined
        ? (patch.sort ?? undefined)
        : (current.sort ?? undefined),
    // `dir` is only meaningful with a sort key; drop it when sort is cleared.
    dir:
      patch.dir !== undefined
        ? (patch.dir ?? undefined)
        : (impliedDir ?? current.dir ?? undefined),
    page: patch.page !== undefined ? String(patch.page ?? "") : String(current.page),
    per: patch.per !== undefined ? String(patch.per ?? "") : String(current.per),
  });

  // Invariant 1: did anything page-resetting actually change?
  const resets = PAGE_RESETTING_KEYS.some(
    (key) => key in patch && !queryValuesEqual(merged[key], current[key]),
  );
  const page = resets ? 1 : merged.page;

  const params = new URLSearchParams();
  if (merged.q) params.set("q", merged.q);
  if (merged.status.length < FEEDBACK_STATUSES.length) {
    for (const status of merged.status) params.append("status", status);
  }
  if (merged.type) params.set("type", merged.type);
  if (merged.sort) {
    params.set("sort", merged.sort);
    params.set("dir", merged.dir);
  }
  if (page > 1) params.set("page", String(page));
  if (merged.per !== DEFAULT_FEEDBACK_PAGE_SIZE) params.set("per", String(merged.per));
  return params;
}

/**
 * `serializeFeedbackQuery` as a query string (no leading `?`).
 * An all-default query serialises to `""`.
 */
export function feedbackQueryString(
  current: FeedbackQuery,
  patch: FeedbackQueryPatch = {},
): string {
  return serializeFeedbackQuery(current, patch).toString();
}

/**
 * The direction a header click should produce: first click uses the column's
 * natural direction, clicking the active column flips it.
 */
export function nextSortDirection(
  current: FeedbackQuery,
  key: FeedbackSortKey,
): SortDirection {
  if (current.sort !== key) return SORT_KEY_DEFAULT_DIR[key];
  return current.dir === "asc" ? "desc" : "asc";
}
