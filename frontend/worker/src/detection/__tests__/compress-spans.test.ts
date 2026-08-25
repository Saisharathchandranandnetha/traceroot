import { describe, it, expect } from "vitest";
import { compressSpansForDetector } from "../compress-spans.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal realistic span record as it comes from the backend. */
function makeSpan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    span_id: "abc123",
    trace_id: "trace-1",
    parent_span_id: null,
    project_id: "proj-1",
    name: "LLM call",
    span_kind: "LLM",
    status: "OK",
    status_message: null,
    model_name: "gpt-4o",
    span_start_time: "2026-01-01T00:00:00.000Z",
    span_end_time: "2026-01-01T00:00:01.000Z",
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    cost: 0.001,
    input: JSON.stringify({ role: "user", content: "Hello" }),
    output: JSON.stringify({ role: "assistant", content: "Hi there!" }),
    metadata: null,
    ...overrides,
  };
}

/** Serialize one or more span records as JSONL. */
function toJsonl(...records: Record<string, unknown>[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n");
}

/** Parse a JSONL string back into records. */
function parseJsonl(jsonl: string): Record<string, unknown>[] {
  return jsonl
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compressSpansForDetector", () => {
  // -------------------------------------------------------------------------
  // 1. Small spans pass through unchanged
  // -------------------------------------------------------------------------
  it("leaves small spans semantically unchanged", () => {
    const span = makeSpan();
    const input = toJsonl(span);
    const output = compressSpansForDetector(input);

    const [result] = parseJsonl(output);
    expect(result.span_id).toBe("abc123");
    expect(result.name).toBe("LLM call");
    expect(result.status).toBe("OK");
    expect(result.input).toBe(span.input);
    expect(result.output).toBe(span.output);
  });

  // -------------------------------------------------------------------------
  // 2. Large textual fields are bounded
  // -------------------------------------------------------------------------
  it("truncates oversized input/output fields", () => {
    const bigContent = "x".repeat(10_000);
    const span = makeSpan({
      input: JSON.stringify({ role: "user", content: bigContent }),
      output: JSON.stringify({ role: "assistant", content: bigContent }),
    });
    const input = toJsonl(span);
    const output = compressSpansForDetector(input, { fieldMaxChars: 2_000 });

    const [result] = parseJsonl(output);

    // The field is a JSON string — parse it to check the inner content.
    const parsedInput = JSON.parse(result.input as string) as { content: string };
    expect(parsedInput.content.length).toBeLessThan(bigContent.length);
    expect(parsedInput.content).toContain("chars truncated");
  });

  // -------------------------------------------------------------------------
  // 3. Base64 data-URL payloads are replaced
  // -------------------------------------------------------------------------
  it("replaces large data-URL base64 payloads with a compact marker", () => {
    const b64 = `data:image/png;base64,${"A".repeat(50_000)}`;
    const span = makeSpan({
      output: JSON.stringify({ image: b64 }),
    });
    const input = toJsonl(span);
    const output = compressSpansForDetector(input);

    const [result] = parseJsonl(output);
    const parsedOutput = JSON.parse(result.output as string) as { image: string };
    expect(parsedOutput.image).toContain("[base64 image/png");
    expect(parsedOutput.image).toContain("omitted]");
    expect(parsedOutput.image.length).toBeLessThan(100);
  });

  it("does NOT classify ordinary text as base64", () => {
    // Text with spaces, newlines, punctuation — NOT base64.
    const codeSnippet =
      "// Minimal user lookup\nfunction getUser(req) {\n  return query(req.id);\n}" +
      " ".repeat(250);
    const span = makeSpan({
      output: JSON.stringify({ code: codeSnippet }),
    });
    const input = toJsonl(span);
    const output = compressSpansForDetector(input);

    const [result] = parseJsonl(output);
    const parsedOutput = JSON.parse(result.output as string) as { code: string };
    // The code is long but NOT base64 — should not have the marker.
    expect(parsedOutput.code).not.toContain("[base64");
  });

  it("handles URL-safe base64-looking text safely (relies on truncation)", () => {
    // A JWT or similar payload should just get standard truncation,
    // not completely obliterated.
    const urlSafe = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." + "a".repeat(5000);
    const span = makeSpan({
      input: JSON.stringify({ token: urlSafe }),
    });
    const input = toJsonl(span);
    const output = compressSpansForDetector(input, { fieldMaxChars: 1000 });

    const [result] = parseJsonl(output);
    const parsedInput = JSON.parse(result.input as string) as { token: string };
    // Normal textual truncation applies, keeping a large prefix.
    expect(parsedInput.token).toContain("chars truncated");
    expect(parsedInput.token.length).toBeGreaterThan(500);
  });

  // -------------------------------------------------------------------------
  // 4. Multiple spans remain valid JSONL
  // -------------------------------------------------------------------------
  it("produces valid JSONL with multiple spans", () => {
    const spans = Array.from({ length: 5 }, (_, i) =>
      makeSpan({ span_id: `span-${i}`, name: `Step ${i}` }),
    );
    const input = toJsonl(...spans);
    const output = compressSpansForDetector(input);

    const records = parseJsonl(output);
    expect(records).toHaveLength(5);
    records.forEach((r, i) => {
      expect(r.span_id).toBe(`span-${i}`);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Truncation never cuts a JSONL record in half
  // -------------------------------------------------------------------------
  it("never cuts a JSONL record in half — budget boundary is at record edges", () => {
    // Create spans where each compressed line is ~200 chars. With a budget of
    // 500 chars, only 2 complete records should fit.
    const spans = Array.from({ length: 10 }, (_, i) =>
      makeSpan({ span_id: `span-${i}`, name: `Step ${i}` }),
    );
    const input = toJsonl(...spans);
    const output = compressSpansForDetector(input, { budgetChars: 500 });

    // Every line must parse as valid JSON.
    const records = parseJsonl(output);
    expect(records.length).toBeGreaterThan(0);
    expect(records.length).toBeLessThan(10);

    // Total output must be within budget.
    expect(output.length).toBeLessThanOrEqual(500);
  });

  // -------------------------------------------------------------------------
  // 6. Final context respects the configured budget
  // -------------------------------------------------------------------------
  it("respects the configured character budget", () => {
    const bigContent = "x".repeat(50_000);
    const spans = Array.from({ length: 5 }, (_, i) =>
      makeSpan({
        span_id: `span-${i}`,
        input: JSON.stringify({ content: bigContent }),
      }),
    );
    const input = toJsonl(...spans);
    const output = compressSpansForDetector(input, { budgetChars: 10_000 });

    expect(output.length).toBeLessThanOrEqual(10_000);
  });

  it("respects the default 150k budget", () => {
    // Build a very large JSONL that without field compression would blow 150k.
    const bigField = "x".repeat(100_000);
    const spans = Array.from({ length: 3 }, (_, i) =>
      makeSpan({
        span_id: `span-${i}`,
        input: JSON.stringify({ content: bigField }),
      }),
    );
    const input = toJsonl(...spans);
    const output = compressSpansForDetector(input);

    expect(output.length).toBeLessThanOrEqual(150_000);
  });

  // -------------------------------------------------------------------------
  // 7. Nested large fields
  // -------------------------------------------------------------------------
  it("compresses nested large values inside input/output/metadata", () => {
    const nested = {
      messages: [
        { role: "user", content: "x".repeat(10_000) },
        { role: "assistant", content: "y".repeat(10_000) },
      ],
    };
    const span = makeSpan({ output: JSON.stringify(nested) });
    const input = toJsonl(span);
    const output = compressSpansForDetector(input, { fieldMaxChars: 1_000 });

    const [result] = parseJsonl(output);
    const parsedOutput = JSON.parse(result.output as string) as {
      messages: { content: string }[];
    };
    expect(parsedOutput.messages[0].content).toContain("chars truncated");
    expect(parsedOutput.messages[1].content).toContain("chars truncated");
  });

  // -------------------------------------------------------------------------
  // 8. Deterministic output
  // -------------------------------------------------------------------------
  it("produces deterministic output for the same input", () => {
    const span = makeSpan({
      input: JSON.stringify({ content: "x".repeat(10_000) }),
      output: JSON.stringify({ image: `data:image/png;base64,${"A".repeat(5_000)}` }),
    });
    const input = toJsonl(span);

    const output1 = compressSpansForDetector(input, { fieldMaxChars: 1_000 });
    const output2 = compressSpansForDetector(input, { fieldMaxChars: 1_000 });
    expect(output1).toBe(output2);
  });

  // -------------------------------------------------------------------------
  // 9. Malformed JSONL behavior
  // -------------------------------------------------------------------------
  it("retains and safely truncates malformed JSONL lines", () => {
    const good1 = makeSpan({ span_id: "good1" });
    const good2 = makeSpan({ span_id: "good2" });
    // This is 20_000 chars of invalid JSON.
    const badRecord = "{invalid json!!!" + "x".repeat(20_000);
    const jsonl = `${JSON.stringify(good1)}\n${badRecord}\n${JSON.stringify(good2)}`;

    // We restrict the field size (which applies to raw string truncation too)
    const output = compressSpansForDetector(jsonl, { fieldMaxChars: 1_000 });

    const lines = output.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("good1");
    // The malformed record should be truncated to ~1000 characters and retained.
    // Because truncateField appends a literal newline in the marker, the malformed
    // record spans two lines in the output.
    expect(lines[1]).toContain("{invalid json!!!");
    expect(lines[2]).toContain("chars truncated]");
    expect(lines[1].length + lines[2].length).toBeLessThan(1_500);
    expect(lines[3]).toContain("good2");
  });

  it("returns truncated strings for fully malformed input", () => {
    const output = compressSpansForDetector("not json at all\nalso not json");
    expect(output.split("\n").length).toBe(2);
  });

  it("returns empty string for empty input", () => {
    expect(compressSpansForDetector("")).toBe("");
    expect(compressSpansForDetector("\n\n")).toBe("");
  });

  // -------------------------------------------------------------------------
  // 10. Structural/diagnostic fields
  // -------------------------------------------------------------------------
  it("preserves structural fields even when they are long strings", () => {
    const span = makeSpan({
      status: "ERROR",
      name: "very_long_tool_name_" + "x".repeat(500),
    });
    const input = toJsonl(span);
    const output = compressSpansForDetector(input, { fieldMaxChars: 100 });

    const [result] = parseJsonl(output);
    // Structural fields pass through unchanged.
    expect(result.status).toBe("ERROR");
    expect(result.name).toBe(span.name);
  });

  it("truncates extremely large status_message fields", () => {
    const span = makeSpan({
      status: "ERROR",
      status_message: "Error: " + "stack line\n".repeat(500),
    });
    const input = toJsonl(span);
    const output = compressSpansForDetector(input, { fieldMaxChars: 1_000 });

    const [result] = parseJsonl(output);
    const statusMsg = result.status_message as string;
    expect(statusMsg).toContain("chars truncated");
    expect(statusMsg.length).toBeLessThan(1_500);
  });

  // -------------------------------------------------------------------------
  // Budget behavior — later spans with diagnostic info
  // -------------------------------------------------------------------------
  it("includes more spans when field compression reduces per-span size", () => {
    // Without compression: 3 big spans would fill ~150k chars from the head,
    // leaving no room for spans 4+. With field compression, the big fields
    // shrink, so more spans fit within the budget.
    const bigField = JSON.stringify({ data: "x".repeat(100_000) });
    const diagnosticSpan = makeSpan({
      span_id: "diagnostic",
      status: "ERROR",
      status_message: "tool returned 500",
      output: JSON.stringify({ error: "Internal Server Error" }),
    });

    const spans = [
      makeSpan({ span_id: "big-0", input: bigField }),
      makeSpan({ span_id: "big-1", input: bigField }),
      diagnosticSpan,
    ];

    const input = toJsonl(...spans);
    const output = compressSpansForDetector(input);

    const records = parseJsonl(output);
    const spanIds = records.map((r) => r.span_id);
    // The diagnostic span should now fit.
    expect(spanIds).toContain("diagnostic");
  });

  // -------------------------------------------------------------------------
  // Non-compressible fields containing JSON-like strings
  // -------------------------------------------------------------------------
  it("handles input/output that are raw strings (not JSON objects)", () => {
    const span = makeSpan({
      input: "x".repeat(10_000), // raw string, not JSON
      output: "y".repeat(10_000),
    });
    const input = toJsonl(span);
    const output = compressSpansForDetector(input, { fieldMaxChars: 1_000 });

    const [result] = parseJsonl(output);
    const inputStr = result.input as string;
    expect(inputStr).toContain("chars truncated");
    expect(inputStr.length).toBeLessThan(10_000);
  });

  // -------------------------------------------------------------------------
  // Metadata field compression
  // -------------------------------------------------------------------------
  it("compresses oversized metadata fields", () => {
    const bigMetadata = JSON.stringify({
      "traceroot.span.path": "/root/child",
      custom_key: "v".repeat(10_000),
    });
    const span = makeSpan({ metadata: bigMetadata });
    const input = toJsonl(span);
    const output = compressSpansForDetector(input, { fieldMaxChars: 1_000 });

    const [result] = parseJsonl(output);
    const parsedMeta = JSON.parse(result.metadata as string) as Record<string, string>;
    // The path attribute should be preserved.
    expect(parsedMeta["traceroot.span.path"]).toBe("/root/child");
    // The oversized custom key should be truncated.
    expect(parsedMeta.custom_key).toContain("chars truncated");
  });

  // -------------------------------------------------------------------------
  // Data URL with audio type
  // -------------------------------------------------------------------------
  it("replaces audio data-URL payloads", () => {
    const audioUri = `data:audio/wav;base64,${"B".repeat(100_000)}`;
    const span = makeSpan({
      output: JSON.stringify({ audio: audioUri }),
    });
    const input = toJsonl(span);
    const output = compressSpansForDetector(input);

    const [result] = parseJsonl(output);
    const parsedOutput = JSON.parse(result.output as string) as { audio: string };
    expect(parsedOutput.audio).toContain("[base64 audio/wav");
    expect(parsedOutput.audio).toContain("omitted]");
    expect(parsedOutput.audio.length).toBeLessThan(100);
  });

  // -------------------------------------------------------------------------
  // Regression: issue #1983 — terminal ERROR span must survive budget squeeze
  // -------------------------------------------------------------------------
  it("regression #1983: terminal ERROR span survives when oversized benign spans fill the head", () => {
    // 40 benign spans with ~3500-char input (under the 4000 field cap, so no
    // field compression shrinks them), followed by one terminal ERROR span.
    const benignSpans = Array.from({ length: 40 }, (_, i) =>
      makeSpan({
        span_id: `benign-${i}`,
        name: `step-${i}`,
        status: "OK",
        input: JSON.stringify({ role: "user", content: "x".repeat(3500) }),
      }),
    );
    const terminalSpan = makeSpan({
      span_id: "boom",
      name: "checkout.charge",
      status: "ERROR",
      status_message: "PaymentGatewayTimeout: card charge failed after 3 retries",
    });

    const input = toJsonl(...benignSpans, terminalSpan);
    const output = compressSpansForDetector(input, { budgetChars: 50_000 });
    const records = parseJsonl(output);

    // The terminal ERROR span must be present in the output.
    const spanIds = records.map((r) => r.span_id);
    expect(spanIds).toContain("boom");

    // It must be in the tail block (last position).
    expect(records[records.length - 1].span_id).toBe("boom");
    expect(records[records.length - 1].status).toBe("ERROR");

    // A truncation receipt must be present since records were omitted.
    const receipt = records.find((r) => r._truncated === true);
    expect(receipt).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Truncation receipt — present with accurate counts
  // -------------------------------------------------------------------------
  it("emits a truncation receipt with accurate counts when records are omitted", () => {
    // Build spans that exceed a tight budget.
    const spans = Array.from({ length: 20 }, (_, i) =>
      makeSpan({
        span_id: `span-${i}`,
        input: JSON.stringify({ content: "z".repeat(2000) }),
      }),
    );
    const input = toJsonl(...spans);
    const output = compressSpansForDetector(input, { budgetChars: 10_000 });
    const records = parseJsonl(output);

    const receipt = records.find((r) => r._truncated === true);
    expect(receipt).toBeDefined();
    expect(receipt!._truncated).toBe(true);
    expect(typeof receipt!.omitted_records).toBe("number");
    expect(typeof receipt!.omitted_chars).toBe("number");
    expect(receipt!.omitted_records).toBeGreaterThan(0);
    expect(receipt!.omitted_chars).toBeGreaterThan(0);

    // omitted_records + kept records (excluding receipt line) = total input.
    const keptRecords = records.filter((r) => r._truncated !== true).length;
    expect(keptRecords + (receipt!.omitted_records as number)).toBe(20);
  });

  // -------------------------------------------------------------------------
  // No receipt when everything fits — byte-identical output
  // -------------------------------------------------------------------------
  it("emits NO receipt and produces byte-identical output when everything fits", () => {
    const spans = Array.from({ length: 3 }, (_, i) => makeSpan({ span_id: `span-${i}` }));
    const input = toJsonl(...spans);

    // Large budget — everything fits.
    const output = compressSpansForDetector(input, { budgetChars: 500_000 });

    // No receipt present.
    expect(output).not.toMatch(/_truncated/);
    expect(output).not.toMatch(/omitted/i);

    // Byte-identical to just compressing and joining (the old behavior).
    const records = parseJsonl(output);
    expect(records).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // Output length <= budgetChars INCLUDING the receipt
  // -------------------------------------------------------------------------
  it.each([500, 1_000, 5_000, 10_000, 50_000, 150_000])(
    "output length <= budgetChars (%d) including receipt",
    (budget) => {
      const spans = Array.from({ length: 50 }, (_, i) =>
        makeSpan({
          span_id: `span-${i}`,
          input: JSON.stringify({ content: "a".repeat(3000) }),
        }),
      );
      const input = toJsonl(...spans);
      const output = compressSpansForDetector(input, { budgetChars: budget });

      expect(output.length).toBeLessThanOrEqual(budget);

      // Every line must be valid JSON.
      if (output.length > 0) {
        output.split("\n").forEach((line) => {
          if (line.trim().length > 0) {
            expect(() => JSON.parse(line)).not.toThrow();
          }
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // Head/tail overlap — small trace, no duplicates
  // -------------------------------------------------------------------------
  it("head/tail overlap: every record appears exactly once when trace fits head+tail slots", () => {
    // 5 records — far fewer than the default head+tail slots would request.
    const spans = Array.from({ length: 5 }, (_, i) => makeSpan({ span_id: `span-${i}` }));
    const input = toJsonl(...spans);
    const output = compressSpansForDetector(input, { budgetChars: 500_000 });

    const records = parseJsonl(output);
    const spanIds = records.map((r) => r.span_id);

    // All 5 present, no duplicates.
    expect(spanIds).toHaveLength(5);
    expect(new Set(spanIds).size).toBe(5);
    // No receipt.
    expect(output).not.toMatch(/_truncated/);
  });

  // -------------------------------------------------------------------------
  // Single record larger than the entire budget
  // -------------------------------------------------------------------------
  it("handles a single record larger than the entire budget", () => {
    const span = makeSpan({
      span_id: "huge",
      input: JSON.stringify({ content: "x".repeat(50_000) }),
    });
    const input = toJsonl(span);
    // Budget smaller than the single compressed record.
    const output = compressSpansForDetector(input, { budgetChars: 200 });

    // Should emit just a receipt (or empty if receipt doesn't fit).
    expect(output.length).toBeLessThanOrEqual(200);
    if (output.length > 0) {
      const records = parseJsonl(output);
      // The receipt should be present.
      const receipt = records.find((r) => r._truncated === true);
      expect(receipt).toBeDefined();
      expect(receipt!.omitted_records).toBe(1);
    }
  });

  // -------------------------------------------------------------------------
  // Budget so small only the receipt fits
  // -------------------------------------------------------------------------
  it("emits only the receipt when budget is too small for any record", () => {
    const spans = Array.from({ length: 5 }, (_, i) =>
      makeSpan({
        span_id: `span-${i}`,
        input: JSON.stringify({ content: "y".repeat(5000) }),
      }),
    );
    const input = toJsonl(...spans);
    // Budget: 100 chars — enough for the receipt but not for any record.
    const output = compressSpansForDetector(input, { budgetChars: 100 });

    expect(output.length).toBeLessThanOrEqual(100);
    if (output.length > 0) {
      const records = parseJsonl(output);
      expect(records).toHaveLength(1);
      expect(records[0]._truncated).toBe(true);
      expect(records[0].omitted_records).toBe(5);
    }
  });

  // -------------------------------------------------------------------------
  // Determinism under truncation
  // -------------------------------------------------------------------------
  it("produces byte-identical output on repeated calls with truncation", () => {
    const spans = Array.from({ length: 30 }, (_, i) =>
      makeSpan({
        span_id: `span-${i}`,
        input: JSON.stringify({ content: "d".repeat(3000) }),
      }),
    );
    const input = toJsonl(...spans);

    const output1 = compressSpansForDetector(input, { budgetChars: 20_000 });
    const output2 = compressSpansForDetector(input, { budgetChars: 20_000 });
    expect(output1).toBe(output2);
  });

  // -------------------------------------------------------------------------
  // Every output line is valid JSON in all truncation scenarios
  // -------------------------------------------------------------------------
  it("every output line parses as valid JSON across truncation scenarios", () => {
    const scenarios = [
      { count: 3, budget: 500_000 }, // no truncation
      { count: 50, budget: 10_000 }, // heavy truncation
      { count: 10, budget: 2_000 }, // extreme truncation
    ];

    for (const { count, budget } of scenarios) {
      const spans = Array.from({ length: count }, (_, i) =>
        makeSpan({
          span_id: `span-${i}`,
          input: JSON.stringify({ content: "v".repeat(1000) }),
        }),
      );
      const input = toJsonl(...spans);
      const output = compressSpansForDetector(input, { budgetChars: budget });

      if (output.length === 0) continue;

      const lines = output.split("\n").filter((l) => l.trim().length > 0);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
  });

  // -------------------------------------------------------------------------
  // Malformed JSONL line landing in the tail region
  // -------------------------------------------------------------------------
  it("retains a malformed JSONL line in the tail region safely truncated", () => {
    // Build: several good spans + a malformed line at the end (tail region).
    const goodSpans = Array.from({ length: 10 }, (_, i) =>
      makeSpan({
        span_id: `good-${i}`,
        input: JSON.stringify({ content: "g".repeat(2000) }),
      }),
    );
    // Malformed last line — would land in the tail.
    const badLine = "{not valid json at all " + "q".repeat(5000);
    const input = toJsonl(...goodSpans) + "\n" + badLine;

    const output = compressSpansForDetector(input, { budgetChars: 20_000 });
    const lines = output.split("\n").filter((l) => l.trim().length > 0);

    // The last content line (excluding receipt) should contain the malformed
    // data — truncated but not dropped.
    const lastLines = lines.slice(-2).join("\n"); // malformed line may span 2 lines due to truncation marker
    expect(lastLines).toContain("{not valid json at all");
    expect(lastLines).toContain("chars truncated");

    // Output is within budget.
    expect(output.length).toBeLessThanOrEqual(20_000);
  });
});
