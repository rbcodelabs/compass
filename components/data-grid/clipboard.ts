/**
 * Clipboard text parsing for the grid.
 *
 * Google Sheets, Excel and Numbers all put tab-separated text on the clipboard
 * (`text/plain`), quoting a cell with `"` when it contains a tab, a newline or a
 * quote (a literal quote is doubled). Windows apps use CRLF between rows and
 * Excel prepends nothing, but a file-backed paste can start with a BOM.
 */

const BOM = "﻿";

/**
 * Parses tab-separated text into rows of cells.
 *
 *  - A cell is quoted only when its first character is `"`; a quote anywhere
 *    else is literal text.
 *  - Inside quotes, tabs and newlines are kept verbatim and `""` is one `"`.
 *  - Rows end at `\r\n`, `\n` or a lone `\r`. A single trailing newline does not
 *    produce an extra empty row (Sheets and Excel both append one).
 *  - A leading BOM is dropped. Empty cells stay as empty strings so columns keep
 *    their position.
 *  - An unterminated quote runs to the end of the text rather than throwing.
 */
export function parseTsv(input: string): string[][] {
  const text = input.startsWith(BOM) ? input.slice(BOM.length) : input;
  if (text === "") return [];

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStart = true;
  // Text has been seen on the current row, so a bare newline at the very end is a
  // terminator, not an empty record.
  let rowHasContent = false;

  const endField = () => {
    row.push(field);
    field = "";
    fieldStart = true;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    rowHasContent = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && fieldStart) {
      inQuotes = true;
      fieldStart = false;
      rowHasContent = true;
    } else if (char === "\t") {
      rowHasContent = true;
      endField();
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      endRow();
    } else {
      field += char;
      fieldStart = false;
      rowHasContent = true;
    }
  }
  if (rowHasContent || field !== "" || row.length > 0) endRow();
  return rows;
}

/**
 * Serialises a matrix of cell text as Google-Sheets-compatible TSV.
 *
 * A cell is wrapped in quotes when it holds a tab, a newline or a quote (a quote
 * is doubled), the same rule Sheets applies, so `parseTsv(formatTsv(m))` returns
 * `m`. Rows are joined with `\n` with no trailing newline; a lone empty cell in
 * the last row of a multi-row matrix is written as `""` so it survives the
 * parser's "a trailing newline is not a row" rule.
 */
export function formatTsv(matrix: readonly (readonly string[])[]): string {
  const lines = matrix.map((row, rowIndex) => {
    const cells = row.map((cell) =>
      /[\t\n\r"]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell,
    );
    const loneEmptyLast =
      rowIndex > 0 && rowIndex === matrix.length - 1 && cells.length === 1 && cells[0] === "";
    return loneEmptyLast ? '""' : cells.join("\t");
  });
  return lines.join("\n");
}

/**
 * Builds the copy matrix for a rectangular range. `textAt` supplies each cell's
 * text (a column's `format`, or its displayed text), so this stays free of rows
 * and columns.
 */
export function rangeToMatrix(
  range: { top: number; left: number; bottom: number; right: number },
  textAt: (row: number, col: number) => string,
): string[][] {
  const matrix: string[][] = [];
  for (let row = range.top; row <= range.bottom; row += 1) {
    const line: string[] = [];
    for (let col = range.left; col <= range.right; col += 1) line.push(textAt(row, col));
    matrix.push(line);
  }
  return matrix;
}
