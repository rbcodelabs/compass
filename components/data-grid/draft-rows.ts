import type {
  GridBatchItemResult,
  GridCreation,
  GridDraftRow,
  GridDraftSubmitItem,
  GridDraftValues,
} from "./types";

/**
 * Pure state for the draft-row area: a reducer, the paste-to-rows mapping, and
 * the chunked submit. Nothing here touches React or the network, so the rules
 * that matter (stable ids across retry, partial failure, chunk limits) are unit
 * tested directly.
 */

export type DraftState = { drafts: GridDraftRow[] };

export const EMPTY_DRAFT_STATE: DraftState = { drafts: [] };

/** Shown on every row of a request that failed as a whole (network, 5xx, thrown action). */
export const UNCONFIRMED_MESSAGE = "Couldn't confirm. Retry is safe.";
/** Shown on rows in later chunks that were never sent because an earlier request failed. */
export const NOT_SENT_MESSAGE = "Not sent because an earlier request failed. Retry is safe.";
const CONFLICT_MESSAGE =
  "This row may already have been created with different values. Refresh to check, then discard it.";

export type DraftAction =
  | { type: "add"; rows: { clientId: string; values: GridDraftValues }[] }
  | { type: "edit"; clientId: string; field: string; value: string }
  | { type: "remove"; clientId: string }
  /** Drops every draft that is not mid-request. */
  | { type: "discard" }
  /** Drops drafts that hold nothing (cleared after being promoted). */
  | { type: "drop"; clientIds: readonly string[] }
  | { type: "pending"; clientIds: readonly string[] }
  /** Client-side validation failures: the row stays a draft and is not sent. */
  | { type: "invalid"; errors: ReadonlyMap<string, Record<string, string>> }
  /** The outcome of one chunk (or its failure as a whole). */
  | { type: "settled"; results: readonly GridBatchItemResult[] }
  | { type: "failed"; clientIds: readonly string[]; message: string };

function describeFailure(result: Extract<GridBatchItemResult, { ok: false }>): {
  fieldErrors: Record<string, string>;
  rowError?: string;
} {
  if (result.code === "CONFLICT") return { fieldErrors: {}, rowError: CONFLICT_MESSAGE };
  if (result.field) return { fieldErrors: { [result.field]: result.error } };
  return { fieldErrors: {}, rowError: result.error };
}

export function draftReducer(state: DraftState, action: DraftAction): DraftState {
  switch (action.type) {
    case "add": {
      if (action.rows.length === 0) return state;
      const known = new Set(state.drafts.map((draft) => draft.clientId));
      const added = action.rows
        .filter((row) => !known.has(row.clientId))
        .map(
          (row): GridDraftRow => ({
            clientId: row.clientId,
            values: row.values,
            status: "draft",
            fieldErrors: {},
          }),
        );
      return added.length === 0 ? state : { drafts: [...state.drafts, ...added] };
    }
    case "edit":
      return {
        drafts: state.drafts.map((draft) => {
          if (draft.clientId !== action.clientId || draft.status === "pending") return draft;
          const { [action.field]: _cleared, ...fieldErrors } = draft.fieldErrors;
          void _cleared;
          return {
            ...draft,
            values: { ...draft.values, [action.field]: action.value },
            // Editing is the user answering the error. The id is kept: a retry
            // after an unconfirmed request must hit the server's dedupe, not
            // create a second row.
            status: "draft",
            fieldErrors,
            rowError: undefined,
          };
        }),
      };
    case "remove":
      return { drafts: state.drafts.filter((draft) => draft.clientId !== action.clientId) };
    case "discard":
      return { drafts: state.drafts.filter((draft) => draft.status === "pending") };
    case "drop": {
      const ids = new Set(action.clientIds);
      return { drafts: state.drafts.filter((draft) => !ids.has(draft.clientId)) };
    }
    case "pending": {
      const ids = new Set(action.clientIds);
      return {
        drafts: state.drafts.map((draft) =>
          ids.has(draft.clientId)
            ? { ...draft, status: "pending", fieldErrors: {}, rowError: undefined }
            : draft,
        ),
      };
    }
    case "invalid":
      return {
        drafts: state.drafts.map((draft) => {
          const errors = action.errors.get(draft.clientId);
          return errors ? { ...draft, status: "error", fieldErrors: errors, rowError: undefined } : draft;
        }),
      };
    case "settled": {
      const byId = new Map(action.results.map((result) => [result.clientId, result]));
      return {
        // A created row leaves the draft area; the server rows redelivered by
        // `revalidatePath` are what the user sees from here on.
        drafts: state.drafts.flatMap((draft): GridDraftRow[] => {
          const result = byId.get(draft.clientId);
          if (!result) return [draft];
          if (result.ok) return [];
          return [{ ...draft, status: "error", ...describeFailure(result) }];
        }),
      };
    }
    case "failed": {
      const ids = new Set(action.clientIds);
      return {
        drafts: state.drafts.map((draft) =>
          ids.has(draft.clientId)
            ? { ...draft, status: "error", fieldErrors: {}, rowError: action.message }
            : draft,
        ),
      };
    }
  }
}

// ── Blank detection ─────────────────────────────────────────────────────────

/** True when every field still holds what a fresh row starts with. */
export function isBlankValues(values: GridDraftValues, defaults: GridDraftValues): boolean {
  return Object.keys({ ...defaults, ...values }).every(
    (key) => (values[key] ?? "").trim() === (defaults[key] ?? "").trim(),
  );
}

// ── Paste ───────────────────────────────────────────────────────────────────

/**
 * Maps pasted rows onto draft values. Cell `i` of a pasted row fills the field
 * `startField + i`; cells beyond the last field are dropped. An empty cell keeps
 * the field's default, so a sheet with a blank Status column does not blank the
 * select. A select cell is matched to an option by value or label, ignoring
 * case; text that matches nothing is kept so validation can name it.
 * Rows that are entirely empty are skipped.
 */
export function pasteToDrafts(
  cells: readonly (readonly string[])[],
  creation: Pick<GridCreation, "fields" | "makeValues">,
  startField: number,
): GridDraftValues[] {
  const out: GridDraftValues[] = [];
  for (const cellRow of cells) {
    if (cellRow.every((cell) => cell.trim() === "")) continue;
    const values = creation.makeValues();
    cellRow.forEach((raw, offset) => {
      const field = creation.fields[startField + offset];
      if (!field) return;
      const text = raw.trim();
      if (text === "") return;
      if (field.kind === "select") {
        const needle = text.toLowerCase();
        const match = field.options?.find(
          (option) => option.value.toLowerCase() === needle || option.label.toLowerCase() === needle,
        );
        values[field.id] = match ? match.value : text;
        return;
      }
      values[field.id] = text;
    });
    out.push(values);
  }
  return out;
}

// ── Chunked submit ──────────────────────────────────────────────────────────

const encoder = new TextEncoder();

export function serializedSize(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

/**
 * Splits items into consecutive chunks that respect BOTH limits. The byte limit
 * is a budget on the JSON form of the items; an item larger than the whole
 * budget travels alone (the server rejects it on its own merits) rather than
 * being dropped or looping forever.
 */
export function chunkItems<T>(
  items: readonly T[],
  limits: { maxItems: number; maxBytes: number },
  measure: (item: T) => number = serializedSize,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = measure(item) + 1; // the comma between array entries
    if (current.length > 0 && (current.length >= limits.maxItems || bytes + size > limits.maxBytes)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export type ChunkedSubmitOutcome = {
  results: GridBatchItemResult[];
  /** Ids in a chunk whose request failed as a whole (the server may or may not have written them). */
  unconfirmed: string[];
  /** Ids in chunks that were never sent because an earlier chunk failed. */
  unsent: string[];
  /** The refusal text when the server answered a request with `ok: false`. */
  requestError?: string;
};

/**
 * Sends chunks sequentially and aggregates the per-item results. Stops at the
 * first request-level failure so a dead network is not hammered N times; the
 * remaining items come back as `unsent`. Never rejects.
 */
export async function submitInChunks(
  items: readonly GridDraftSubmitItem[],
  creation: Pick<GridCreation, "submit" | "limits">,
): Promise<ChunkedSubmitOutcome> {
  const chunks = chunkItems(items, creation.limits);
  const outcome: ChunkedSubmitOutcome = { results: [], unconfirmed: [], unsent: [] };
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    let response: Awaited<ReturnType<GridCreation["submit"]>> | null = null;
    try {
      response = await creation.submit(chunk);
    } catch {
      response = null;
    }
    if (!response || !response.ok) {
      if (response && !response.ok) outcome.requestError = response.error;
      outcome.unconfirmed.push(...chunk.map((item) => item.clientId));
      for (const later of chunks.slice(index + 1)) outcome.unsent.push(...later.map((item) => item.clientId));
      return outcome;
    }
    outcome.results.push(...response.results);
    // A malformed response must not leave rows pending forever.
    const answered = new Set(response.results.map((result) => result.clientId));
    for (const item of chunk) if (!answered.has(item.clientId)) outcome.unconfirmed.push(item.clientId);
  }
  return outcome;
}
