/**
 * Field-level compression for detector span context.
 *
 * The detector judge receives a JSONL dump of all spans in a trace. Today the
 * dump is hard-capped at SAFETY_TRUNCATE_CHARS characters by slicing the raw
 * string — which can cut a JSON record in half, drop later diagnostic spans
 * entirely if earlier spans are large, and send huge base64/binary payloads
 * that consume budget without adding diagnostic value.
 *
 * This module compresses each span record at the FIELD level before the
 * character budget is enforced, so:
 *   1. Oversized textual fields (input, output, metadata) are head-truncated
 *      with a deterministic marker.
 *   2. Large data-URL / base64 payloads are replaced with a compact marker.
 *   3. The budget is enforced at record boundaries — no JSONL line is ever
 *      cut in half.
 *   4. Small spans pass through unchanged.
 *
 * The utility is intentionally narrow: it does NOT rank, reorder, or
 * semantically select spans. That is future work (evidence-aware selection).
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default per-field character cap. Fields below this limit pass through. */
const DEFAULT_FIELD_MAX_CHARS = 4_000;

/**
 * Upper-bound character length of the truncation receipt line. Derived from the
 * longest plausible serialization:
 *   `{"_truncated":true,"omitted_records":99999,"omitted_chars":999999999}`
 * which is 68 characters. We round up to 80 to absorb any future field additions
 * without re-deriving. This is subtracted from the budget BEFORE filling records
 * so the receipt can never push the output over `budgetChars`.
 */
const RECEIPT_MAX_CHARS = 80;

/**
 * Default fraction of the record budget reserved for the tail block (last-M
 * records). 0.3 keeps 70% of chronological context in the head while
 * guaranteeing the terminal ~30% of records survive a budget squeeze — enough
 * for phase-1 deterministic selection without ranking or scoring.
 */
const DEFAULT_TAIL_BUDGET_FRACTION = 0.3;

/**
 * Regex for data-URL prefixes we recognize. Captures the media type so the
 * replacement marker can report what was removed.
 */
const DATA_URL_RE = /^data:([^;,]{1,80});base64,/;

// ---------------------------------------------------------------------------
// Field-level helpers
// ---------------------------------------------------------------------------

/**
 * Replace a large data-URL string with a compact marker.
 * Returns the original string unchanged if it does not look like a data-URL.
 */
function replaceBase64(value: string): string {
  const dataUrlMatch = value.match(DATA_URL_RE);
  if (dataUrlMatch) {
    const mediaType = dataUrlMatch[1];
    const payloadLength = value.length - dataUrlMatch[0].length;
    return `[base64 ${mediaType} ~${payloadLength} chars omitted]`;
  }
  return value;
}

/**
 * Truncate a string to `maxChars`, preserving a head portion and appending a
 * deterministic marker that communicates how much was removed. Strings at or
 * below the limit pass through unchanged.
 */
function truncateField(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  // Keep a head, drop the tail, append a marker.
  const kept = maxChars - 40; // reserve space for the marker
  const head = value.slice(0, Math.max(kept, 0));
  const dropped = value.length - kept;
  return head + "\n…[" + dropped + " chars truncated]";
}

/**
 * Compress a single value: strings get base64-replaced then truncated;
 * arrays and objects are walked recursively. Non-string primitives pass
 * through unchanged.
 */
function compressValue(value: unknown, fieldMaxChars: number): unknown {
  if (typeof value === "string") {
    const replaced = replaceBase64(value);
    return truncateField(replaced, fieldMaxChars);
  }
  if (Array.isArray(value)) {
    return value.map((item) => compressValue(item, fieldMaxChars));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        compressValue(v, fieldMaxChars),
      ]),
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Span-level compression
// ---------------------------------------------------------------------------

/**
 * Fields whose values can grow large and are eligible for compression.
 * Includes status_message to bound unbounded stack traces.
 * Structural / diagnostic fields (span_id, trace_id, name, status,
 * model_name, span_kind, etc.) are never compressed.
 */
const COMPRESSIBLE_FIELDS = new Set(["input", "output", "metadata", "status_message"]);

/**
 * Compress a single parsed span record. Fields in COMPRESSIBLE_FIELDS are
 * walked and compressed; all other fields pass through byte-identical.
 */
function compressSpanRecord(
  record: Record<string, unknown>,
  fieldMaxChars: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (COMPRESSIBLE_FIELDS.has(key) && value !== null && value !== undefined) {
      // input, output, metadata are stored as JSON strings in ClickHouse.
      // They arrive here as strings (from the JSONL dump). Parse them to
      // walk their internal structure, then re-serialize.
      if (typeof value === "string") {
        try {
          const parsed = JSON.parse(value) as unknown;
          const compressed = compressValue(parsed, fieldMaxChars);
          result[key] = JSON.stringify(compressed);
        } catch {
          // Not valid JSON — compress the raw string.
          result[key] = truncateField(replaceBase64(value as string), fieldMaxChars);
        }
      } else {
        // Already an object (shouldn't happen from the backend, but be safe).
        result[key] = compressValue(value, fieldMaxChars);
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CompressSpansOptions {
  /** Total character budget for the compressed JSONL output. */
  budgetChars?: number;
  /** Per-field character cap for compressible string fields. */
  fieldMaxChars?: number;
  /**
   * Fraction of the record budget reserved for the tail block (0–1).
   * The tail block preserves the last-M records so terminal failure spans
   * survive a budget squeeze. Default: 0.3 (30%).
   *
   * Purely positional — no ranking, scoring, or content inspection.
   */
  tailBudgetFraction?: number;
}

/**
 * Build the truncation receipt JSON line. Only called when records were
 * actually omitted. The receipt is a real JSON object on its own line so
 * the output remains valid JSONL end-to-end.
 *
 * `omittedChars` counts post-compression characters of the omitted records —
 * i.e. what the budget loop measured, not the raw pre-compression size. This
 * is the right metric because it reflects what the judge would have seen.
 */
function buildReceipt(omittedRecords: number, omittedChars: number): string {
  return JSON.stringify({
    _truncated: true,
    omitted_records: omittedRecords,
    omitted_chars: omittedChars,
  });
}

/**
 * Compress a spans JSONL string for detector context.
 *
 * 1. Parses JSONL into individual span records.
 * 2. Compresses oversized fields (input, output, metadata, status_message) at the field level.
 * 3. Replaces large data-URL payloads with compact markers.
 * 4. Selects head (first-N) and tail (last-M) records within the character
 *    budget, preserving chronological order with a truncation receipt at the
 *    gap position when records are omitted.
 * 5. Enforces the total character budget at RECORD boundaries — no line is
 *    ever cut in half, and the output is always valid JSONL.
 * 6. Malformed lines are retained and safely truncated as raw strings so
 *    telemetry corruption is not silently hidden.
 *
 * @param spansJsonl  Raw JSONL string (newline-delimited JSON span records).
 * @param options     Optional overrides for budget, field limits, and tail fraction.
 * @returns           Compressed JSONL string respecting the budget.
 */
export function compressSpansForDetector(
  spansJsonl: string,
  options?: CompressSpansOptions,
): string {
  const budgetChars = options?.budgetChars ?? 150_000;
  const fieldMaxChars = options?.fieldMaxChars ?? DEFAULT_FIELD_MAX_CHARS;
  const tailFraction = options?.tailBudgetFraction ?? DEFAULT_TAIL_BUDGET_FRACTION;

  // Split into lines, filter empties.
  const lines = spansJsonl.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return "";

  // -----------------------------------------------------------------------
  // Phase 1: Compress every record at the field level.
  // -----------------------------------------------------------------------
  const compressed: string[] = [];
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      compressed.push(JSON.stringify(compressSpanRecord(record, fieldMaxChars)));
    } catch {
      // Malformed JSON line — do not silently drop. Hide nothing from the
      // evaluation. Treat the entire line as a single oversized string to
      // preserve evidence safely.
      compressed.push(truncateField(replaceBase64(line), fieldMaxChars));
    }
  }

  // -----------------------------------------------------------------------
  // Phase 2: Select head + tail records within the character budget.
  //
  // Reserve the receipt's worst-case length from the budget BEFORE filling
  // records. This prevents appending the receipt from pushing the output
  // over budgetChars — the exact overflow bug this module exists to prevent.
  // -----------------------------------------------------------------------

  // First, check if everything fits without any truncation. This is the
  // fast path and preserves byte-identical output for traces under budget.
  const totalUntruncated = compressed.reduce(
    (sum, line, i) => sum + line.length + (i > 0 ? 1 : 0),
    0,
  );
  if (totalUntruncated <= budgetChars) {
    return compressed.join("\n");
  }

  // Some records must be omitted. Reserve space for the receipt + its
  // preceding newline so it can always be inserted without overflow.
  const receiptReservation = RECEIPT_MAX_CHARS + 1; // +1 for the newline before it
  const effectiveBudget = Math.max(budgetChars - receiptReservation, 0);

  // Compute character length of each compressed line (without newlines).
  const lineLengths = compressed.map((l) => l.length);

  // Fill the head: walk forward until the head budget is exhausted.
  // The head gets (1 - tailFraction) of the effective budget.
  const headBudget = Math.floor(effectiveBudget * (1 - tailFraction));
  let headCount = 0;
  let headChars = 0;
  for (let i = 0; i < compressed.length; i++) {
    const cost = lineLengths[i] + (headCount > 0 ? 1 : 0); // +1 for newline separator
    if (headChars + cost > headBudget) break;
    headChars += cost;
    headCount++;
  }

  // Fill the tail: walk backward from the end until the tail budget is
  // exhausted. The tail gets the remainder of the effective budget.
  const tailBudget = effectiveBudget - headChars;
  let tailCount = 0;
  let tailChars = 0;
  for (let i = compressed.length - 1; i >= headCount; i--) {
    // +1 for the newline before this tail record (receipt or previous tail line)
    const cost = lineLengths[i] + 1;
    if (tailChars + cost > tailBudget) break;
    tailChars += cost;
    tailCount++;
  }

  // If the tail is empty because the last record exceeds the tail budget,
  // try to make room by shrinking the head. This ensures the terminal span
  // is never completely starved while staying within the total budget.
  if (tailCount === 0 && headCount < compressed.length) {
    const lastIdx = compressed.length - 1;
    const lastCost = lineLengths[lastIdx] + 1; // +1 for newline
    // Shrink head until the last record fits within the effective budget.
    while (headCount > 0 && headChars + lastCost > effectiveBudget) {
      headCount--;
      // Recompute headChars from scratch to avoid newline accounting drift.
      headChars = compressed
        .slice(0, headCount)
        .reduce((sum, l, i) => sum + l.length + (i > 0 ? 1 : 0), 0);
    }
    // Check if the last record now fits alongside the (possibly empty) head.
    if (headChars + lastCost <= effectiveBudget) {
      tailCount = 1;
      tailChars = lastCost;
    }
  }

  // -----------------------------------------------------------------------
  // Phase 3: Assemble output — head, receipt, tail — in chronological order.
  // -----------------------------------------------------------------------
  const headBlock = compressed.slice(0, headCount);
  const tailStart = compressed.length - tailCount;
  const tailBlock = compressed.slice(tailStart);

  const omittedRecords = compressed.length - headCount - tailCount;
  const omittedChars = compressed
    .slice(headCount, tailStart)
    .reduce((sum, line) => sum + line.length, 0);

  const parts: string[] = [];
  if (headBlock.length > 0) parts.push(...headBlock);

  // Receipt at the gap position — only when records were actually omitted.
  if (omittedRecords > 0) {
    parts.push(buildReceipt(omittedRecords, omittedChars));
  }

  if (tailBlock.length > 0) parts.push(...tailBlock);

  // Edge case: budget so small that no head or tail records fit, but the
  // receipt itself still fits within the original budget.
  if (parts.length === 0 && compressed.length > 0) {
    const allChars = compressed.reduce((sum, line) => sum + line.length, 0);
    const receipt = buildReceipt(compressed.length, allChars);
    if (receipt.length <= budgetChars) {
      return receipt;
    }
    return "";
  }

  return parts.join("\n");
}
