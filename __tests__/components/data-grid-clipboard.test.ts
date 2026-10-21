import { describe, expect, it } from "vitest";

import { parseTsv } from "@/components/data-grid/clipboard";

describe("parseTsv", () => {
  it("splits cells on tabs and rows on newlines", () => {
    expect(parseTsv("a\tb\tc\nd\te\tf")).toEqual([
      ["a", "b", "c"],
      ["d", "e", "f"],
    ]);
  });

  it("returns no rows for empty input", () => {
    expect(parseTsv("")).toEqual([]);
  });

  it("does not add a row for a single trailing newline (Sheets and Excel append one)", () => {
    expect(parseTsv("a\tb\n")).toEqual([["a", "b"]]);
    expect(parseTsv("a\tb\r\n")).toEqual([["a", "b"]]);
  });

  it("keeps a genuinely blank row in the middle", () => {
    expect(parseTsv("a\n\nb")).toEqual([["a"], [""], ["b"]]);
  });

  it("handles CRLF and a lone CR as row separators", () => {
    expect(parseTsv("a\tb\r\nc\td\r\ne\tf")).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
    ]);
    expect(parseTsv("a\rb")).toEqual([["a"], ["b"]]);
  });

  it("keeps empty cells so columns hold their position", () => {
    expect(parseTsv("a\t\tc\n\tb\t")).toEqual([
      ["a", "", "c"],
      ["", "b", ""],
    ]);
  });

  it("unquotes a quoted cell and un-doubles embedded quotes", () => {
    expect(parseTsv('"say ""hi"""\tplain')).toEqual([['say "hi"', "plain"]]);
  });

  it("keeps tabs and newlines inside quotes", () => {
    expect(parseTsv('"line one\nline two"\t"has\ttab"\n"crlf\r\ninside"\tz')).toEqual([
      ["line one\nline two", "has\ttab"],
      ["crlf\r\ninside", "z"],
    ]);
  });

  it("treats a quote that is not at the start of a cell as literal text", () => {
    expect(parseTsv('5" pipe\tab"c')).toEqual([['5" pipe', 'ab"c']]);
  });

  it("parses an empty quoted cell", () => {
    expect(parseTsv('""\tx')).toEqual([["", "x"]]);
    expect(parseTsv('x\t""')).toEqual([["x", ""]]);
  });

  it("drops a leading BOM", () => {
    expect(parseTsv("﻿title\tsegment\nOne\tTwo")).toEqual([
      ["title", "segment"],
      ["One", "Two"],
    ]);
  });

  it("does not throw on an unterminated quote", () => {
    expect(parseTsv('"never closed\tstill in the cell')).toEqual([["never closed\tstill in the cell"]]);
  });

  it("parses a Google Sheets copy: quoted cells, CRLF, trailing newline", () => {
    const text = [
      'Title\tSegment\tDescription',
      '"Onboarding, but ""confusing"""\tNew teams\t"Step 1\nStep 2"',
      "Reporting\t\tplain",
      "",
    ].join("\r\n");
    expect(parseTsv(text)).toEqual([
      ["Title", "Segment", "Description"],
      ['Onboarding, but "confusing"', "New teams", "Step 1\nStep 2"],
      ["Reporting", "", "plain"],
    ]);
  });
});
