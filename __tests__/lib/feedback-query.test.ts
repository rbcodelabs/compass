import { describe, expect, it } from "vitest";
import {
  DEFAULT_FEEDBACK_PAGE_SIZE,
  DEFAULT_FEEDBACK_QUERY,
  FEEDBACK_PAGE_SIZES,
  FEEDBACK_SORT_KEYS,
  MAX_FEEDBACK_PAGE,
  MAX_FEEDBACK_Q_LENGTH,
  buildFeedbackOrderBy,
  buildFeedbackWhere,
  feedbackPageCount,
  feedbackQueryString,
  feedbackSkip,
  feedbackTake,
  nextSortDirection,
  parseFeedbackQuery,
  serializeFeedbackQuery,
  type FeedbackQuery,
  type FeedbackSearchParams,
} from "@/lib/feedback-query";

/** Parse from a query string, exactly as Next would hand it to a page. */
function fromUrl(search: string): FeedbackQuery {
  return parseFeedbackQuery(new URLSearchParams(search));
}

function query(overrides: Partial<FeedbackQuery> = {}): FeedbackQuery {
  return { ...DEFAULT_FEEDBACK_QUERY, ...overrides };
}

describe("parseFeedbackQuery: defaults", () => {
  it("returns the documented default for empty, null and undefined input", () => {
    expect(parseFeedbackQuery(undefined)).toEqual(DEFAULT_FEEDBACK_QUERY);
    expect(parseFeedbackQuery(null)).toEqual(DEFAULT_FEEDBACK_QUERY);
    expect(parseFeedbackQuery({})).toEqual(DEFAULT_FEEDBACK_QUERY);
    expect(fromUrl("")).toEqual(DEFAULT_FEEDBACK_QUERY);
    expect(DEFAULT_FEEDBACK_QUERY).toEqual({
      q: null,
      status: null,
      type: null,
      sort: null,
      dir: "desc",
      page: 1,
      per: 25,
    });
  });

  it("accepts a Next-shaped searchParams object as well as URLSearchParams", () => {
    const params: FeedbackSearchParams = {
      status: "OPEN",
      sort: "votes",
      dir: "asc",
      page: "3",
      per: "50",
      q: "dark mode",
    };
    expect(parseFeedbackQuery(params)).toEqual(
      query({ status: "OPEN", sort: "votes", dir: "asc", page: 3, per: 50, q: "dark mode" }),
    );
    expect(fromUrl("status=OPEN&sort=votes&dir=asc&page=3&per=50&q=dark+mode")).toEqual(
      parseFeedbackQuery(params),
    );
  });
});

describe("buildFeedbackOrderBy: ordering contract", () => {
  it("preserves today's ordering when no sort is given", () => {
    expect(buildFeedbackOrderBy(DEFAULT_FEEDBACK_QUERY)).toEqual([
      { voteCount: "desc" },
      { createdAt: "desc" },
      { id: "asc" },
    ]);
  });

  it("appends the {id:'asc'} tiebreak on EVERY sort path", () => {
    const paths: FeedbackQuery[] = [
      DEFAULT_FEEDBACK_QUERY,
      // every key x every direction
      ...FEEDBACK_SORT_KEYS.flatMap((sort) => [
        query({ sort, dir: "asc" }),
        query({ sort, dir: "desc" }),
      ]),
      // hostile inputs that degrade to the default path
      fromUrl("sort=voteCount);DROP"),
      fromUrl("sort=&dir="),
      fromUrl("sort=__proto__"),
    ];

    for (const path of paths) {
      const orderBy = buildFeedbackOrderBy(path);
      const last = orderBy[orderBy.length - 1];
      expect(last, `sort=${String(path.sort)} dir=${path.dir}`).toEqual({ id: "asc" });
      // exactly one id clause, and it is last
      expect(orderBy.filter((clause) => "id" in clause)).toHaveLength(1);
    }
  });

  it("maps public sort keys onto their real columns", () => {
    expect(buildFeedbackOrderBy(query({ sort: "votes", dir: "desc" }))).toEqual([
      { voteCount: "desc" },
      { id: "asc" },
    ]);
    expect(buildFeedbackOrderBy(query({ sort: "created", dir: "asc" }))).toEqual([
      { createdAt: "asc" },
      { id: "asc" },
    ]);
    expect(buildFeedbackOrderBy(query({ sort: "title", dir: "asc" }))).toEqual([
      { title: "asc" },
      { id: "asc" },
    ]);
    expect(buildFeedbackOrderBy(query({ sort: "status", dir: "desc" }))).toEqual([
      { status: "desc" },
      { id: "asc" },
    ]);
    expect(buildFeedbackOrderBy(query({ sort: "type", dir: "asc" }))).toEqual([
      { type: "asc" },
      { id: "asc" },
    ]);
  });

  it("never emits a column name that is not in the fixed key table", () => {
    const allowed = new Set(["title", "status", "type", "voteCount", "createdAt", "id"]);
    const hostile = [
      "voteCount);DROP",
      "voteCount",          // the COLUMN name is not a valid public key
      "createdAt",
      "id",
      "1;--",
      "title asc, x",
      "__proto__",
      "constructor",
    ];
    for (const raw of hostile) {
      const parsed = fromUrl(`sort=${encodeURIComponent(raw)}`);
      for (const clause of buildFeedbackOrderBy(parsed)) {
        for (const key of Object.keys(clause)) {
          expect(allowed, `sort=${raw} produced column ${key}`).toContain(key);
        }
      }
    }
  });

  it("uses a per-column natural direction when dir is absent or junk", () => {
    expect(fromUrl("sort=votes").dir).toBe("desc");
    expect(fromUrl("sort=created").dir).toBe("desc");
    expect(fromUrl("sort=title").dir).toBe("asc");
    expect(fromUrl("sort=status").dir).toBe("asc");
    expect(fromUrl("sort=type").dir).toBe("asc");
    // junk direction falls back to the same natural direction
    expect(fromUrl("sort=title&dir=DESC").dir).toBe("asc");
    expect(fromUrl("sort=title&dir=sideways").dir).toBe("asc");
    expect(fromUrl("sort=votes&dir=; DROP").dir).toBe("desc");
  });
});

describe("parseFeedbackQuery: hostile and malformed input", () => {
  it("silently drops a SQL-injection-shaped sort key", () => {
    const parsed = fromUrl("sort=voteCount);DROP");
    expect(parsed.sort).toBeNull();
    expect(buildFeedbackOrderBy(parsed)).toEqual([
      { voteCount: "desc" },
      { createdAt: "desc" },
      { id: "asc" },
    ]);
  });

  it("clamps or defaults every bad page value without throwing", () => {
    expect(fromUrl("page=-1").page).toBe(1);
    expect(fromUrl("page=0").page).toBe(1);
    expect(fromUrl("page=abc").page).toBe(1);
    expect(fromUrl("page=1e9").page).toBe(1);
    expect(fromUrl("page=1.5").page).toBe(1);
    expect(fromUrl("page=%20%203").page).toBe(1);
    expect(fromUrl("page=0x10").page).toBe(1);
    expect(fromUrl("page=Infinity").page).toBe(1);
    expect(fromUrl("page=NaN").page).toBe(1);
    expect(fromUrl("page=").page).toBe(1);
    // valid digits above the ceiling are CLAMPED, not defaulted
    expect(fromUrl("page=999999").page).toBe(MAX_FEEDBACK_PAGE);
    expect(fromUrl(`page=${MAX_FEEDBACK_PAGE}`).page).toBe(MAX_FEEDBACK_PAGE);
    expect(fromUrl("page=7").page).toBe(7);
  });

  it("bounds skip so a hostile page cannot force an unbounded offset", () => {
    const worst = fromUrl("page=999999&per=100");
    expect(feedbackSkip(worst)).toBe((MAX_FEEDBACK_PAGE - 1) * 100);
    expect(feedbackTake(worst)).toBe(100);
    expect(Number.isSafeInteger(feedbackSkip(worst))).toBe(true);
  });

  it("rejects any page size outside the closed set", () => {
    expect(fromUrl("per=1000").per).toBe(DEFAULT_FEEDBACK_PAGE_SIZE);
    expect(fromUrl("per=0").per).toBe(DEFAULT_FEEDBACK_PAGE_SIZE);
    expect(fromUrl("per=-25").per).toBe(DEFAULT_FEEDBACK_PAGE_SIZE);
    expect(fromUrl("per=26").per).toBe(DEFAULT_FEEDBACK_PAGE_SIZE);
    expect(fromUrl("per=abc").per).toBe(DEFAULT_FEEDBACK_PAGE_SIZE);
    expect(fromUrl("per=").per).toBe(DEFAULT_FEEDBACK_PAGE_SIZE);
    for (const size of FEEDBACK_PAGE_SIZES) {
      expect(fromUrl(`per=${size}`).per).toBe(size);
    }
  });

  it("requires a whole-string allowlist match for status and type", () => {
    expect(fromUrl("status=OPEN").status).toBe("OPEN");
    // partial match must NOT slip through
    expect(fromUrl("status=OPEN,BOGUS").status).toBeNull();
    expect(fromUrl("status=BOGUS,OPEN").status).toBeNull();
    expect(fromUrl("status=OPEN%20").status).toBeNull();
    expect(fromUrl("status=open").status).toBeNull();
    expect(fromUrl("status=BOGUS").status).toBeNull();
    expect(fromUrl("status=__proto__").status).toBeNull();
    expect(fromUrl("type=BUG").type).toBe("BUG");
    expect(fromUrl("type=IDEA,BUG").type).toBeNull();
    expect(fromUrl("type=OPEN").type).toBeNull();
  });

  it("normalises array-valued params by taking the LAST value", () => {
    expect(fromUrl("status=BOGUS&status=OPEN").status).toBe("OPEN");
    expect(fromUrl("status=OPEN&status=BOGUS").status).toBeNull();
    expect(fromUrl("page=2&page=5").page).toBe(5);
    expect(fromUrl("per=50&per=100").per).toBe(100);
    expect(fromUrl("sort=title&sort=votes").sort).toBe("votes");
    expect(fromUrl("q=ab&q=zebra").q).toBe("zebra");

    // the same, via the object form Next actually passes
    expect(
      parseFeedbackQuery({
        status: ["BOGUS", "OPEN"],
        type: ["BUG", "IDEA"],
        page: ["1", "4"],
        per: ["25", "100"],
        sort: ["title", "created"],
        dir: ["asc", "desc"],
        q: ["x", "dark"],
      }),
    ).toEqual(
      query({ status: "OPEN", type: "IDEA", page: 4, per: 100, sort: "created", dir: "desc", q: "dark" }),
    );

    // empty arrays and non-string members degrade to the default
    expect(parseFeedbackQuery({ status: [], page: [], per: [] })).toEqual(
      DEFAULT_FEEDBACK_QUERY,
    );
  });

  it("trims, caps and length-gates the text search", () => {
    // ignored below the minimum length
    expect(fromUrl("q=a").q).toBeNull();
    expect(fromUrl("q=%20%20").q).toBeNull();
    expect(fromUrl("q=%20a%20").q).toBeNull();
    expect(fromUrl("q=").q).toBeNull();
    // trimmed
    expect(fromUrl("q=%20%20dark%20mode%20%20").q).toBe("dark mode");
    // exactly at the minimum is kept
    expect(fromUrl("q=ab").q).toBe("ab");
    // truncated, never rejected
    const long = "a".repeat(150);
    const parsed = fromUrl(`q=${long}`);
    expect(parsed.q).toHaveLength(MAX_FEEDBACK_Q_LENGTH);
    expect(parsed.q).toBe("a".repeat(MAX_FEEDBACK_Q_LENGTH));
    // a long hostile string is truncated but still only ever a `contains` value
    const injection = `%' OR 1=1 --${"x".repeat(200)}`;
    expect(fromUrl(`q=${encodeURIComponent(injection)}`).q).toHaveLength(
      MAX_FEEDBACK_Q_LENGTH,
    );
  });

  it("never throws on any hostile combination", () => {
    const nasties = [
      "sort=voteCount);DROP&dir=;--&page=-1&per=1000&status=OPEN,BOGUS&q=a",
      "page=1e9&per=0&type=%00&status=%FF",
      "q=" + "%20".repeat(200),
      "sort[]=votes&page[]=2",
      "__proto__=x&constructor=y",
      "page=99999999999999999999",
    ];
    for (const search of nasties) {
      expect(() => fromUrl(search)).not.toThrow();
      const parsed = fromUrl(search);
      expect(() => buildFeedbackOrderBy(parsed)).not.toThrow();
      expect(() => buildFeedbackWhere(parsed, "ws_1")).not.toThrow();
      expect(parsed.page).toBeGreaterThanOrEqual(1);
      expect(parsed.page).toBeLessThanOrEqual(MAX_FEEDBACK_PAGE);
      expect(FEEDBACK_PAGE_SIZES).toContain(parsed.per);
    }
  });

  it("does not let a prototype-polluted object leak a value", () => {
    const polluted = Object.create({ status: "COMPLETED", page: "9" }) as FeedbackSearchParams;
    const parsed = parseFeedbackQuery(polluted);
    expect(parsed.status).toBeNull();
    expect(parsed.page).toBe(1);
  });
});

describe("buildFeedbackWhere", () => {
  it("always scopes to the workspace", () => {
    expect(buildFeedbackWhere(DEFAULT_FEEDBACK_QUERY, "ws_1")).toEqual({
      workspaceId: "ws_1",
    });
  });

  it("adds only the filters that survived validation", () => {
    expect(
      buildFeedbackWhere(fromUrl("status=OPEN&type=BUG&q=dark"), "ws_1"),
    ).toEqual({
      workspaceId: "ws_1",
      status: "OPEN",
      type: "BUG",
      OR: [
        { title: { contains: "dark", mode: "insensitive" } },
        { description: { contains: "dark", mode: "insensitive" } },
      ],
    });
    // hostile values are simply absent
    expect(
      buildFeedbackWhere(fromUrl("status=OPEN,BOGUS&type=X&q=a"), "ws_1"),
    ).toEqual({ workspaceId: "ws_1" });
  });

  it("produces the SAME object shape for findMany and count", () => {
    const parsed = fromUrl("status=PLANNED&q=export");
    const where = buildFeedbackWhere(parsed, "ws_1");
    // The caller is meant to reuse one object; prove it is a plain reusable value.
    expect(buildFeedbackWhere(parsed, "ws_1")).toEqual(where);
    expect(where).not.toBe(buildFeedbackWhere(parsed, "ws_1"));
  });
});

describe("feedbackPageCount", () => {
  it("computes pages from the server total", () => {
    expect(feedbackPageCount(query({ per: 25 }), 57)).toBe(3);
    expect(feedbackPageCount(query({ per: 25 }), 25)).toBe(1);
    expect(feedbackPageCount(query({ per: 25 }), 26)).toBe(2);
    expect(feedbackPageCount(query({ per: 100 }), 57)).toBe(1);
    // an empty list is still one (empty) page
    expect(feedbackPageCount(query(), 0)).toBe(1);
    expect(feedbackPageCount(query(), -5)).toBe(1);
  });
});

describe("serializeFeedbackQuery: page reset invariant", () => {
  const onPage5 = query({ page: 5, status: "OPEN", sort: "votes", dir: "desc", per: 50 });

  it("resets page to 1 on a FILTER change", () => {
    expect(serializeFeedbackQuery(onPage5, { status: "PLANNED" }).get("page")).toBeNull();
    expect(serializeFeedbackQuery(onPage5, { status: null }).get("page")).toBeNull();
    expect(serializeFeedbackQuery(onPage5, { type: "BUG" }).get("page")).toBeNull();
    expect(serializeFeedbackQuery(onPage5, { q: "dark mode" }).get("page")).toBeNull();
  });

  it("resets page to 1 on a SORT change", () => {
    expect(serializeFeedbackQuery(onPage5, { sort: "title" }).get("page")).toBeNull();
    expect(serializeFeedbackQuery(onPage5, { dir: "asc" }).get("page")).toBeNull();
    expect(serializeFeedbackQuery(onPage5, { sort: null }).get("page")).toBeNull();
  });

  it("resets page to 1 on a PAGE SIZE change", () => {
    expect(serializeFeedbackQuery(onPage5, { per: 100 }).get("page")).toBeNull();
    expect(serializeFeedbackQuery(onPage5, { per: 25 }).get("page")).toBeNull();
  });

  it("resets even when the caller also tries to keep the page", () => {
    // The invariant lives in the serializer, so a caller cannot opt out.
    const params = serializeFeedbackQuery(onPage5, { status: "PLANNED", page: 5 });
    expect(params.get("page")).toBeNull();
    expect(params.get("status")).toBe("PLANNED");
  });

  it("keeps the page when ONLY the page changes", () => {
    expect(serializeFeedbackQuery(onPage5, { page: 2 }).get("page")).toBe("2");
    expect(serializeFeedbackQuery(onPage5, { page: 1 }).get("page")).toBeNull();
    expect(serializeFeedbackQuery(onPage5, {}).get("page")).toBe("5");
  });

  it("keeps the page when a patch is a NO-OP", () => {
    // Re-selecting the already-active filter should not throw the user to page 1.
    expect(serializeFeedbackQuery(onPage5, { status: "OPEN" }).get("page")).toBe("5");
    expect(serializeFeedbackQuery(onPage5, { per: 50 }).get("page")).toBe("5");
    expect(serializeFeedbackQuery(onPage5, { sort: "votes", dir: "desc" }).get("page")).toBe("5");
  });

  it("resets the page when a hostile patch value is coerced away", () => {
    // status OPEN -> (invalid) null is still a change, so the offset is stale.
    expect(serializeFeedbackQuery(onPage5, { status: "BOGUS" }).get("page")).toBeNull();
    expect(serializeFeedbackQuery(onPage5, { status: "BOGUS" }).get("status")).toBeNull();
  });
});

describe("serializeFeedbackQuery: output shape", () => {
  it("omits every default so a cleared grid produces a bare URL", () => {
    expect(feedbackQueryString(DEFAULT_FEEDBACK_QUERY)).toBe("");
    expect(
      feedbackQueryString(query({ status: "OPEN", page: 3 }), { status: null }),
    ).toBe("");
  });

  it("emits dir only alongside sort", () => {
    const withSort = serializeFeedbackQuery(query(), { sort: "title" });
    expect(withSort.get("sort")).toBe("title");
    expect(withSort.get("dir")).toBe("asc");

    const noSort = serializeFeedbackQuery(query({ sort: "title", dir: "asc" }), {
      sort: null,
    });
    expect(noSort.get("sort")).toBeNull();
    expect(noSort.get("dir")).toBeNull();
  });

  it("derives the header-click direction when a sort patch omits dir", () => {
    // new column -> its natural direction, NOT the previous column's direction
    const fromVotesDesc = query({ sort: "votes", dir: "desc" });
    expect(serializeFeedbackQuery(fromVotesDesc, { sort: "title" }).get("dir")).toBe("asc");
    expect(serializeFeedbackQuery(query({ sort: "title", dir: "asc" }), { sort: "votes" }).get("dir")).toBe("desc");
    // same column -> flip
    expect(serializeFeedbackQuery(fromVotesDesc, { sort: "votes" }).get("dir")).toBe("asc");
    expect(
      serializeFeedbackQuery(query({ sort: "votes", dir: "asc" }), { sort: "votes" }).get("dir"),
    ).toBe("desc");
    // an explicit dir always wins over the derived one
    expect(serializeFeedbackQuery(fromVotesDesc, { sort: "title", dir: "desc" }).get("dir")).toBe("desc");
  });

  it("round-trips through the parser", () => {
    const original = query({
      q: "dark mode",
      status: "PLANNED",
      type: "IDEA",
      sort: "created",
      dir: "asc",
      page: 4,
      per: 100,
    });
    expect(parseFeedbackQuery(serializeFeedbackQuery(original))).toEqual(original);
  });

  it("re-validates the patch so an unvalidated string cannot reach the URL", () => {
    const params = serializeFeedbackQuery(query(), {
      sort: "voteCount);DROP",
      status: "'; DELETE FROM feedback --",
      per: 9999,
    });
    expect(params.get("sort")).toBeNull();
    expect(params.get("status")).toBeNull();
    expect(params.get("per")).toBeNull();
    expect(params.toString()).toBe("");
  });
});

describe("nextSortDirection", () => {
  it("uses the natural direction for a new column and flips the active one", () => {
    expect(nextSortDirection(query(), "votes")).toBe("desc");
    expect(nextSortDirection(query(), "title")).toBe("asc");
    expect(nextSortDirection(query({ sort: "title", dir: "asc" }), "title")).toBe("desc");
    expect(nextSortDirection(query({ sort: "title", dir: "desc" }), "title")).toBe("asc");
    expect(nextSortDirection(query({ sort: "title", dir: "desc" }), "votes")).toBe("desc");
  });
});
