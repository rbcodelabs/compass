import { describe, expect, it } from "vitest";

import {
  formatCellValue,
  parseCellText,
  parseDateOnly,
} from "@/components/data-grid/cells/cell-values";
import type { GridEdit } from "@/components/data-grid/types";

type Row = { v: unknown };

/** Minimal edit config; `save` and `field` are irrelevant to parsing. */
// The kind generic is only documentation at call sites; the config is untyped.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function edit<_K extends GridEdit<Row>["kind"]>(
  config: Record<string, unknown>,
): GridEdit<Row> {
  return {
    field: "v",
    save: async () => ({ ok: true }),
    getValue: (row: Row) => row.v,
    ...config,
  } as unknown as GridEdit<Row>;
}

describe("parseDateOnly", () => {
  it.each([
    ["2026-10-20", "2026-10-20"],
    ["10/20/2026", "2026-10-20"],
    ["1/2/2026", "2026-01-02"],
    ["2026-10-20T13:45:00.000Z", "2026-10-20"],
  ])("accepts %s", (input, expected) => {
    expect(parseDateOnly(input)).toEqual({ ok: true, value: expected });
  });

  it.each(["2026-02-31", "13/02/2026", "20/10/2026", "tomorrow", "2026-1-2", ""])(
    "rejects %s rather than guessing",
    (input) => {
      expect(parseDateOnly(input).ok).toBe(false);
    },
  );
});

describe("parseCellText", () => {
  it("text: trims, maps blank to null and enforces maxLength", () => {
    const e = edit<"text">({ kind: "text", maxLength: 5 });
    expect(parseCellText(e, "  hi ")).toEqual({ ok: true, value: "hi" });
    expect(parseCellText(e, "   ")).toEqual({ ok: true, value: null });
    expect(parseCellText(e, "toolong").ok).toBe(false);
  });

  it("number: strips thousands separators and enforces bounds", () => {
    const e = edit<"number">({ kind: "number", min: 0, max: 100, integer: true });
    expect(parseCellText(e, "1,0")).toEqual({ ok: true, value: 10 });
    expect(parseCellText(e, "")).toEqual({ ok: true, value: null });
    expect(parseCellText(e, "abc").ok).toBe(false);
    expect(parseCellText(e, "1.5").ok).toBe(false);
    expect(parseCellText(e, "-1").ok).toBe(false);
    expect(parseCellText(e, "101").ok).toBe(false);
  });

  it("url: only http(s)", () => {
    const e = edit<"url">({ kind: "url" });
    expect(parseCellText(e, "https://example.com/a")).toEqual({
      ok: true,
      value: "https://example.com/a",
    });
    expect(parseCellText(e, "javascript:alert(1)").ok).toBe(false);
    expect(parseCellText(e, "example.com").ok).toBe(false);
    expect(parseCellText(e, "")).toEqual({ ok: true, value: null });
  });

  it("checkbox: understands Sheets' TRUE / FALSE", () => {
    const e = edit<"checkbox">({ kind: "checkbox" });
    expect(parseCellText(e, "TRUE")).toEqual({ ok: true, value: true });
    expect(parseCellText(e, "false")).toEqual({ ok: true, value: false });
    expect(parseCellText(e, "maybe").ok).toBe(false);
  });

  it("select: matches value or label, case-insensitively", () => {
    const e = edit<"select">({
      kind: "select",
      options: [{ value: "IN_REVIEW", label: "In review" }],
    });
    expect(parseCellText(e, "in review")).toEqual({ ok: true, value: "IN_REVIEW" });
    expect(parseCellText(e, "IN_REVIEW")).toEqual({ ok: true, value: "IN_REVIEW" });
    expect(parseCellText(e, "done").ok).toBe(false);
  });

  it("person: email first, then exact name; ambiguity is an error, never a guess", () => {
    const e = edit<"person">({
      kind: "person",
      allowUnassigned: true,
      options: [
        { value: "u1", label: "Sam Lee", email: "sam@x.com" },
        { value: "u2", label: "Sam Lee", email: "other@x.com" },
        { value: "u3", label: "Ana Ruiz", email: "ana@x.com" },
      ],
    });
    expect(parseCellText(e, "SAM@x.com")).toEqual({ ok: true, value: "u1" });
    expect(parseCellText(e, "ana ruiz")).toEqual({ ok: true, value: "u3" });
    expect(parseCellText(e, "Sam Lee").ok).toBe(false);
    expect(parseCellText(e, "Nobody").ok).toBe(false);
    expect(parseCellText(e, "")).toEqual({ ok: true, value: null });
  });

  it("person: blank is an error unless unassigning is allowed", () => {
    const e = edit<"person">({ kind: "person", options: [] });
    expect(parseCellText(e, "").ok).toBe(false);
  });

  it("a column's own parse wins", () => {
    const e = edit<"text">({
      kind: "text",
      parse: (text: string) => ({ ok: true, value: text.toUpperCase() }),
    });
    expect(parseCellText(e, "abc")).toEqual({ ok: true, value: "ABC" });
  });
});

describe("formatCellValue / parseCellText round trips", () => {
  const cases: Array<[string, GridEdit<Row>, unknown]> = [
    ["text", edit<"text">({ kind: "text" }), "Hello"],
    ["number", edit<"number">({ kind: "number" }), 12.5],
    ["date", edit<"date">({ kind: "date" }), "2026-10-20"],
    ["url", edit<"url">({ kind: "url" }), "https://example.com"],
    ["checkbox", edit<"checkbox">({ kind: "checkbox" }), true],
    [
      "select",
      edit<"select">({ kind: "select", options: [{ value: "A", label: "Alpha" }] }),
      "A",
    ],
    [
      "person",
      edit<"person">({
        kind: "person",
        options: [{ value: "u1", label: "Sam Lee" }],
      }),
      "u1",
    ],
  ];

  it.each(cases)("%s survives format then parse", (_kind, e, value) => {
    const text = formatCellValue(e, { v: value });
    expect(parseCellText(e, text)).toEqual({ ok: true, value });
  });

  it("formats null as empty text", () => {
    expect(formatCellValue(edit<"text">({ kind: "text" }), { v: null })).toBe("");
  });
});
