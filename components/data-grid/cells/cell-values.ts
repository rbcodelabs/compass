import type {
  GridCellValue,
  GridEdit,
  GridParseResult,
  GridRowData,
} from "../types";

/**
 * Pure text <-> value conversion for every edit kind. Kept free of React so the
 * round trips (and later, clipboard paste) are unit-testable without a DOM.
 *
 * A column's own `parse` / `format` always wins; these are the per-kind defaults.
 */

const fail = <V>(error: string): GridParseResult<V> => ({ ok: false, error });
const ok = <V>(value: V): GridParseResult<V> => ({ ok: true, value });

/** `YYYY-MM-DD` that names a real calendar day (rejects 2026-02-31). */
function isRealDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/**
 * Accepts `YYYY-MM-DD`, `M/D/YYYY` and ISO datetimes; rejects everything else.
 * `D/M` is never guessed: `13/02/2026` is an error, not 13 February, because a
 * silent wrong date from a paste is worse than a rejected cell.
 */
export function parseDateOnly(text: string): GridParseResult<string> {
  const trimmed = text.trim();

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(trimmed);
  if (iso) {
    const [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    if (!isRealDate(year, month, day)) return fail("Enter a real date");
    if (trimmed.length > 10 && Number.isNaN(new Date(trimmed).getTime())) {
      return fail("Enter a date as YYYY-MM-DD");
    }
    return ok(`${pad(year, 4)}-${pad(month)}-${pad(day)}`);
  }

  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (us) {
    const [month, day, year] = [Number(us[1]), Number(us[2]), Number(us[3])];
    if (!isRealDate(year, month, day)) return fail("Enter a real date");
    return ok(`${pad(year, 4)}-${pad(month)}-${pad(day)}`);
  }

  return fail("Enter a date as YYYY-MM-DD");
}

function parseUrl(text: string): GridParseResult<string> {
  const trimmed = text.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return fail("Enter an http(s) link");
    }
    return ok(trimmed);
  } catch {
    return fail("Enter an http(s) link");
  }
}

const TRUE_WORDS = new Set(["true", "yes", "y", "1", "checked", "✓", "x"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0", "unchecked", ""]);

/** Default parser for an edit config. Never throws. */
export function parseCellText<TRow extends GridRowData>(
  edit: GridEdit<TRow>,
  text: string,
  row?: TRow,
): GridParseResult<GridCellValue> {
  // The union's `parse` members have different value types, so the custom hook
  // is invoked through a widened signature; its own kind produced the result.
  const custom = edit.parse as
    | ((text: string, row?: TRow) => GridParseResult<GridCellValue>)
    | undefined;
  if (custom) return custom(text, row);

  switch (edit.kind) {
    case "text": {
      const value = text.trim();
      if (value === "") return ok(null);
      if (edit.maxLength !== undefined && value.length > edit.maxLength) {
        return fail(`Keep this to ${edit.maxLength} characters or fewer`);
      }
      return ok(value);
    }
    case "number": {
      const raw = text.trim().replace(/,/g, "");
      if (raw === "") return ok(null);
      const value = Number(raw);
      if (!Number.isFinite(value)) return fail("Enter a number");
      if (edit.integer && !Number.isInteger(value)) return fail("Enter a whole number");
      if (edit.min !== undefined && value < edit.min) return fail(`Must be at least ${edit.min}`);
      if (edit.max !== undefined && value > edit.max) return fail(`Must be at most ${edit.max}`);
      return ok(value);
    }
    case "date":
      return text.trim() === "" ? ok(null) : parseDateOnly(text);
    case "url":
      return text.trim() === "" ? ok(null) : parseUrl(text);
    case "checkbox": {
      const word = text.trim().toLowerCase();
      if (TRUE_WORDS.has(word)) return ok(true);
      if (FALSE_WORDS.has(word)) return ok(false);
      return fail("Enter true or false");
    }
    case "select": {
      const needle = text.trim().toLowerCase();
      const match = edit.options.find(
        (option) =>
          option.value.toLowerCase() === needle ||
          option.label.toLowerCase() === needle,
      );
      return match ? ok(match.value) : fail("Not one of the available options");
    }
    case "person": {
      const needle = text.trim().toLowerCase();
      if (needle === "") {
        return edit.allowUnassigned ? ok(null) : fail("Choose a person");
      }
      // Email is unambiguous, so it is tried first; names can collide.
      const byEmail = edit.options.filter(
        (option) => option.email?.toLowerCase() === needle,
      );
      const matches =
        byEmail.length > 0
          ? byEmail
          : edit.options.filter((option) => option.label.toLowerCase() === needle);
      if (matches.length === 0) return fail("No matching person");
      if (matches.length > 1) return fail("More than one person matches");
      return ok(matches[0].value);
    }
  }
}

/** Text shown in an editor and used for copy. Never throws. */
export function formatCellValue<TRow extends GridRowData>(
  edit: GridEdit<TRow>,
  row: TRow,
): string {
  const value = edit.getValue(row);
  const custom = edit.format as
    | ((value: GridCellValue, row: TRow) => string)
    | undefined;
  if (custom) return custom(value, row);

  switch (edit.kind) {
    case "checkbox":
      return value ? "TRUE" : "FALSE";
    case "select":
      return edit.options.find((option) => option.value === value)?.label ?? String(value ?? "");
    case "person":
      return edit.options.find((option) => option.value === value)?.label ?? "";
    default:
      return value === null || value === undefined ? "" : String(value);
  }
}
