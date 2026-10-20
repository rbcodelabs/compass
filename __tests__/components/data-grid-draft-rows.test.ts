import { describe, expect, it, vi } from "vitest";

import {
  EMPTY_DRAFT_STATE,
  NOT_SENT_MESSAGE,
  UNCONFIRMED_MESSAGE,
  chunkItems,
  draftReducer,
  isBlankValues,
  pasteToDrafts,
  serializedSize,
  submitInChunks,
  type DraftState,
} from "@/components/data-grid/draft-rows";
import type { GridBatchResult, GridCreation, GridDraftSubmitItem } from "@/components/data-grid/types";

const FIELDS: GridCreation["fields"] = [
  { id: "title", label: "Title", kind: "text" },
  { id: "segment", label: "Segment", kind: "text" },
  {
    id: "status",
    label: "Status",
    kind: "select",
    options: [
      { value: "EXPLORING", label: "Exploring" },
      { value: "ACTIVE", label: "Active" },
    ],
  },
];
const makeValues = () => ({ title: "", segment: "", status: "EXPLORING" });

const add = (state: DraftState, ...ids: string[]) =>
  draftReducer(state, { type: "add", rows: ids.map((clientId) => ({ clientId, values: { ...makeValues(), title: clientId } })) });

describe("draftReducer", () => {
  it("adds drafts in order and ignores a repeated clientId", () => {
    let state = add(EMPTY_DRAFT_STATE, "a", "b");
    state = add(state, "b", "c");
    expect(state.drafts.map((d) => d.clientId)).toEqual(["a", "b", "c"]);
    expect(state.drafts.every((d) => d.status === "draft")).toBe(true);
  });

  it("edit changes one field, clears that field's error and the row error, and keeps the id", () => {
    let state = add(EMPTY_DRAFT_STATE, "a");
    state = draftReducer(state, { type: "invalid", errors: new Map([["a", { title: "Too long", segment: "Bad" }]]) });
    state = draftReducer(state, { type: "edit", clientId: "a", field: "title", value: "Shorter" });
    expect(state.drafts[0]).toMatchObject({
      clientId: "a",
      status: "draft",
      values: { title: "Shorter" },
      fieldErrors: { segment: "Bad" },
    });
  });

  it("does not edit a draft that is mid-request", () => {
    let state = add(EMPTY_DRAFT_STATE, "a");
    state = draftReducer(state, { type: "pending", clientIds: ["a"] });
    const after = draftReducer(state, { type: "edit", clientId: "a", field: "title", value: "x" });
    expect(after.drafts[0].values.title).toBe("a");
  });

  it("a created result removes the draft; a failed one keeps it with the same id and the field error", () => {
    let state = add(EMPTY_DRAFT_STATE, "a", "b", "c");
    state = draftReducer(state, { type: "pending", clientIds: ["a", "b", "c"] });
    state = draftReducer(state, {
      type: "settled",
      results: [
        { clientId: "a", ok: true, id: "a" },
        { clientId: "b", ok: false, code: "INVALID", error: "Title must be 255 characters or fewer.", field: "title" },
        { clientId: "c", ok: false, code: "INTERNAL", error: "Could not create this item. Retrying is safe." },
      ],
    });
    expect(state.drafts.map((d) => d.clientId)).toEqual(["b", "c"]);
    expect(state.drafts[0]).toMatchObject({ status: "error", fieldErrors: { title: "Title must be 255 characters or fewer." } });
    expect(state.drafts[1]).toMatchObject({ status: "error", fieldErrors: {}, rowError: "Could not create this item. Retrying is safe." });
  });

  it("a CONFLICT result gets a row message, never the raw server text", () => {
    let state = add(EMPTY_DRAFT_STATE, "a");
    state = draftReducer(state, {
      type: "settled",
      results: [{ clientId: "a", ok: false, code: "CONFLICT", error: "This id is already in use." }],
    });
    expect(state.drafts[0].rowError).toMatch(/already have been created/i);
  });

  it("a request-level failure marks rows with the message and keeps them", () => {
    let state = add(EMPTY_DRAFT_STATE, "a", "b");
    state = draftReducer(state, { type: "failed", clientIds: ["a"], message: UNCONFIRMED_MESSAGE });
    expect(state.drafts[0]).toMatchObject({ status: "error", rowError: UNCONFIRMED_MESSAGE });
    expect(state.drafts[1].status).toBe("draft");
  });

  it("discard drops everything except rows that are mid-request", () => {
    let state = add(EMPTY_DRAFT_STATE, "a", "b");
    state = draftReducer(state, { type: "pending", clientIds: ["a"] });
    state = draftReducer(state, { type: "discard" });
    expect(state.drafts.map((d) => d.clientId)).toEqual(["a"]);
  });

  it("remove and drop delete by id", () => {
    let state = add(EMPTY_DRAFT_STATE, "a", "b", "c");
    state = draftReducer(state, { type: "remove", clientId: "b" });
    state = draftReducer(state, { type: "drop", clientIds: ["c"] });
    expect(state.drafts.map((d) => d.clientId)).toEqual(["a"]);
  });
});

describe("isBlankValues", () => {
  it("is blank when every field equals its default, ignoring whitespace", () => {
    expect(isBlankValues({ ...makeValues(), title: "  " }, makeValues())).toBe(true);
    expect(isBlankValues({ ...makeValues(), title: "x" }, makeValues())).toBe(false);
    expect(isBlankValues({ ...makeValues(), status: "ACTIVE" }, makeValues())).toBe(false);
  });
});

describe("pasteToDrafts", () => {
  const creation = { fields: FIELDS, makeValues };

  it("maps cells onto fields from the starting field and keeps defaults for empty cells", () => {
    const rows = pasteToDrafts([["One", "", ""], ["Two", "Teams", "Active"]], creation, 0);
    expect(rows).toEqual([
      { title: "One", segment: "", status: "EXPLORING" },
      { title: "Two", segment: "Teams", status: "ACTIVE" },
    ]);
  });

  it("matches a select by value or label, case-insensitively, and keeps unmatched text so validation can name it", () => {
    const rows = pasteToDrafts([["a", "", "active"], ["b", "", "ACTIVE"], ["c", "", "Someday"]], creation, 0);
    expect(rows.map((r) => r.status)).toEqual(["ACTIVE", "ACTIVE", "Someday"]);
  });

  it("starts at the focused field and drops cells beyond the last field", () => {
    const rows = pasteToDrafts([["Teams", "Active", "extra"]], creation, 1);
    expect(rows).toEqual([{ title: "", segment: "Teams", status: "ACTIVE" }]);
  });

  it("skips rows that are entirely empty", () => {
    expect(pasteToDrafts([["", "", ""], ["x"], [""]], creation, 0)).toHaveLength(1);
  });
});

describe("chunkItems", () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ clientId: `id-${i}`, values: { title: "t" } }));

  it("splits by item count", () => {
    const chunks = chunkItems(items(250), { maxItems: 100, maxBytes: 1e9 });
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
  });

  it("splits by serialized size, preserving order", () => {
    const big = (id: string) => ({ clientId: id, values: { title: "x".repeat(1000) } });
    const input = [big("a"), big("b"), big("c"), big("d"), big("e")];
    const one = serializedSize(input[0]);
    const chunks = chunkItems(input, { maxItems: 100, maxBytes: one * 2 + 5 });
    expect(chunks.map((c) => c.map((i) => i.clientId))).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("counts UTF-8 bytes, not characters", () => {
    expect(serializedSize({ title: "é" })).toBeGreaterThan(JSON.stringify({ title: "é" }).length);
  });

  it("sends an item larger than the whole budget alone instead of dropping it", () => {
    const huge = { clientId: "huge", values: { title: "x".repeat(5000) } };
    const chunks = chunkItems([{ clientId: "a", values: { title: "t" } }, huge, { clientId: "b", values: { title: "t" } }], {
      maxItems: 100,
      maxBytes: 200,
    });
    expect(chunks.map((c) => c.map((i) => i.clientId))).toEqual([["a"], ["huge"], ["b"]]);
  });

  it("returns no chunks for no items", () => {
    expect(chunkItems([], { maxItems: 100, maxBytes: 100 })).toEqual([]);
  });
});

describe("submitInChunks", () => {
  const items = (n: number): GridDraftSubmitItem[] =>
    Array.from({ length: n }, (_, i) => ({ clientId: `id-${i}`, values: { title: `t${i}` } }));
  const ok = (chunk: GridDraftSubmitItem[]): GridBatchResult => ({
    ok: true,
    results: chunk.map((i) => ({ clientId: i.clientId, ok: true as const, id: i.clientId })),
  });

  it("sends sequential chunks within both limits and aggregates every result", async () => {
    const calls: number[] = [];
    const submit = vi.fn(async (chunk: GridDraftSubmitItem[]) => {
      calls.push(chunk.length);
      return ok(chunk);
    });
    const outcome = await submitInChunks(items(230), { submit, limits: { maxItems: 100, maxBytes: 1e9 } });
    expect(calls).toEqual([100, 100, 30]);
    expect(outcome.results).toHaveLength(230);
    expect(outcome.unconfirmed).toEqual([]);
    expect(outcome.unsent).toEqual([]);
  });

  it("stops at the first request-level failure: that chunk is unconfirmed, later chunks unsent", async () => {
    const submit = vi
      .fn<(chunk: GridDraftSubmitItem[]) => Promise<GridBatchResult>>()
      .mockImplementationOnce(async (chunk) => ok(chunk))
      .mockRejectedValueOnce(new Error("network"));
    const outcome = await submitInChunks(items(5), { submit, limits: { maxItems: 2, maxBytes: 1e9 } });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(outcome.results.map((r) => r.clientId)).toEqual(["id-0", "id-1"]);
    expect(outcome.unconfirmed).toEqual(["id-2", "id-3"]);
    expect(outcome.unsent).toEqual(["id-4"]);
  });

  it("carries the refusal text of an ok:false response", async () => {
    const submit = vi.fn(async (): Promise<GridBatchResult> => ({ ok: false, error: "Create at most 100 items per request. Nothing was created." }));
    const outcome = await submitInChunks(items(1), { submit, limits: { maxItems: 100, maxBytes: 1e9 } });
    expect(outcome.requestError).toMatch(/at most 100/);
    expect(outcome.unconfirmed).toEqual(["id-0"]);
  });

  it("treats items missing from a response as unconfirmed so they cannot stay pending", async () => {
    const submit = vi.fn(async (chunk: GridDraftSubmitItem[]) => ok(chunk.slice(0, 1)));
    const outcome = await submitInChunks(items(3), { submit, limits: { maxItems: 100, maxBytes: 1e9 } });
    expect(outcome.unconfirmed).toEqual(["id-1", "id-2"]);
  });

  it("exposes the not-sent message for callers", () => {
    expect(NOT_SENT_MESSAGE).toMatch(/Retry is safe/);
  });
});
