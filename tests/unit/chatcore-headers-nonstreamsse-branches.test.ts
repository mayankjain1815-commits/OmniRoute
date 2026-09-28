import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  getHeaderValueCaseInsensitive,
  resolveCompressionHeader,
} from "../../open-sse/handlers/chatCore/headers.ts";
import {
  convertNDJSONToSSE,
  isTruthyStreamBody,
  isEventStreamAccepted,
  appendNonStreamingSseTerminalSignal,
  parseNonStreamingSSEPayload,
  shouldTreatBufferedEventResponseAsExpected,
  type NonStreamingSseTerminalState,
} from "../../open-sse/handlers/chatCore/nonStreamingSse.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";

/**
 * Branch coverage for the guards in `chatCore/headers.ts` and
 * `chatCore/nonStreamingSse.ts` that no other suite asserts.
 *
 * These are not speculative tests: every one of them was written because a
 * specific mutant of the production code survived the existing suites
 * (`scripts/ad-hoc/mutants-headers-nonstreamsse.mjs` rewrites the guard, runs
 * the covering tests, and restores the source). The mutant named in each
 * comment is killed by the test directly below it. Two guards — the
 * `typeof headers !== "object"` half and the redundant `.trim()` in
 * `resolveCompressionHeader` — need a deliberately shaped input to be
 * observable at all; the comments say why.
 */

const freshState = (): NonStreamingSseTerminalState => ({ currentEvent: "", pendingLine: "" });

describe("getHeaderValueCaseInsensitive — input-shape guards", () => {
  test("a primitive is never scanned as a header bag, even when its index keys would match", () => {
    // The guard is `!headers || typeof headers !== "object"`. For a truthy
    // non-null primitive only the `typeof` half fires, so the assertion targets an
    // index key: `Object.entries("xy")` yields [["0","x"],["1","y"]], and
    // "0".toLowerCase() === "0" would satisfy every remaining condition. Only the
    // typeof check stands between the lookup and that match.
    assert.equal(getHeaderValueCaseInsensitive("xy" as never, "0"), null);
    assert.equal(getHeaderValueCaseInsensitive("xy" as never, "1"), null);
    // Numbers/booleans have no enumerable keys at all, so they are rejected too.
    assert.equal(getHeaderValueCaseInsensitive(42 as never, "0"), null);
    assert.equal(getHeaderValueCaseInsensitive(true as never, "0"), null);
  });

  test("null/undefined headers return null instead of throwing", () => {
    assert.equal(getHeaderValueCaseInsensitive(null, "accept"), null);
    assert.equal(getHeaderValueCaseInsensitive(undefined, "accept"), null);
  });
});

describe("resolveCompressionHeader — whitespace contract", () => {
  test("a padded value is returned trimmed, and a blank value is null", () => {
    // Both halves of this contract are pinned even though the `.trim()` in this
    // function is currently redundant (getHeaderValueCaseInsensitive already
    // trims before returning). It is kept as defence-in-depth for the string
    // type it is typed to receive, and this test is what would catch a future
    // change to the inner helper making that redundancy load-bearing.
    assert.equal(resolveCompressionHeader({ "x-omniroute-compression": "  gzip  " }), "gzip");
    assert.equal(resolveCompressionHeader({ "x-omniroute-compression": "\tgzip" }), "gzip");
    assert.equal(resolveCompressionHeader({ "x-omniroute-compression": "   " }), null);
    assert.equal(resolveCompressionHeader({}), null);
  });
});

describe("convertNDJSONToSSE — per-line framing", () => {
  test("each record is trimmed before being wrapped in a data: frame", () => {
    // Mutant: drop the per-line trim() -> frames keep the surrounding padding.
    // Each frame already ends in "\n" and the frames are joined with "\n", so
    // consecutive records are separated by a blank line.
    const raw = '   {"a":1}   \n\t{"b":2}\t\n';
    assert.equal(convertNDJSONToSSE(raw), 'data: {"a":1}\n\ndata: {"b":2}\n\n');
  });

  test("a body with no records is returned untouched", () => {
    // Mutant: drop the `chunks.length === 0` early return -> returns "" instead
    // of the caller's own bytes.
    const blank = "   \n\n\t\n";
    assert.equal(convertNDJSONToSSE(blank), blank);
    assert.equal(convertNDJSONToSSE(""), "");
  });
});

describe("isTruthyStreamBody — only plain payloads count", () => {
  test("a truthy non-object carrying stream:true is still rejected", () => {
    // Mutant: drop the `typeof body === "object"` guard -> a function with a
    // stream property is accepted as a streaming payload.
    const fn = Object.assign(() => "not a payload", { stream: true });
    assert.equal(isTruthyStreamBody(fn), false);
  });

  test("a plain object needs stream to be exactly true", () => {
    assert.equal(isTruthyStreamBody({ stream: true }), true);
    assert.equal(isTruthyStreamBody({ stream: "true" }), false);
    assert.equal(isTruthyStreamBody({ stream: 1 }), false);
    assert.equal(isTruthyStreamBody({}), false);
    assert.equal(isTruthyStreamBody(null), false);
  });
});

describe("isEventStreamAccepted — case-insensitive accept", () => {
  test("an upper-case accept value is still recognised", () => {
    // Mutant: drop the toLowerCase() -> `includes` misses mixed-case values.
    assert.equal(isEventStreamAccepted({ accept: "TEXT/EVENT-STREAM" }), true);
    assert.equal(isEventStreamAccepted({ accept: "text/Event-Stream, application/json" }), true);
    assert.equal(isEventStreamAccepted({ accept: "application/json" }), false);
  });
});

describe("appendNonStreamingSseTerminalSignal — state resets", () => {
  test("a blank line clears the pending event name", () => {
    // Without the clear, a stale `message_delta` would keep the stop_reason
    // superset armed and a later delta payload would be misread as terminal.
    const withBlankLine = freshState();
    assert.equal(
      appendNonStreamingSseTerminalSignal(
        withBlankLine,
        'event: message_delta\n\ndata: {"delta":{"stop_reason":"end_turn"}}\n'
      ),
      false
    );
    assert.equal(withBlankLine.currentEvent, "");

    // Contrast: the same payload IS terminal while `message_delta` is still the
    // pending event. That asymmetry is what the reset exists to produce.
    const withoutBlankLine = freshState();
    assert.equal(
      appendNonStreamingSseTerminalSignal(
        withoutBlankLine,
        'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"}}\n'
      ),
      true
    );
  });

  test("an empty data: line is not terminal on its own", () => {
    // Mutant: `if (!data) return true` -> a bare `data:` frame ends the scan.
    const state = freshState();
    assert.equal(
      appendNonStreamingSseTerminalSignal(state, "event: message_start\ndata:\n"),
      false
    );
  });
});

describe("appendNonStreamingSseTerminalSignal — terminal detection", () => {
  test("a Gemini finishReason frame with no type field is terminal", () => {
    // Mutant: the `"finishReason"` superset no longer triggers a JSON.parse -> the
    // fast path returns before the frame is inspected.
    const state = freshState();
    const done = appendNonStreamingSseTerminalSignal(
      state,
      'data: {"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"hi"}]}}]}\n'
    );
    assert.equal(done, true);
  });

  test("a truncated frame is skipped so a later frame can still be read", () => {
    // Mutant: the JSON.parse catch returns true -> one malformed frame ends the
    // scan and the rest of the body is never inspected.
    const state = freshState();
    const done = appendNonStreamingSseTerminalSignal(
      state,
      'data: {"type":"response.completed"\ndata: {"ok":1}\n'
    );
    assert.equal(done, false);
    // The next complete terminal frame is still found.
    assert.equal(
      appendNonStreamingSseTerminalSignal(state, 'data: {"type":"response.done"}\n'),
      true
    );
  });
});

describe("parseNonStreamingSSEPayload — the built-in fallback chain", () => {
  // The queue always seeds the preferred format first, then Gemini,
  // openai-responses, Claude and OpenAI. Every suite so far passed the payload's
  // own format as the *preferred* one, so the four seeded fallbacks were never
  // reached — removing any one of the four queueFormat() calls was invisible.
  // These pass an empty preferred format so only the seeded list can resolve the
  // payload, which is what makes each call load-bearing.

  const CLAUDE_BUF =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m","model":"c","role":"assistant","usage":{"input_tokens":1}}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n';

  const OPENAI_BUF =
    'data: {"id":"x","choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n';

  // parseSSEToGeminiResponse reads `response.candidates` (the wrapper the
  // Antigravity/CLI surface emits) or a `markdown` shortcut — not a bare
  // top-level `candidates`, which every seeded parser rejects.
  const GEMINI_BUF =
    'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":2,"totalTokenCount":3}}}\n\n';

  test("an OpenAI buffer resolves via the seeded OpenAI fallback", () => {
    const result = parseNonStreamingSSEPayload(OPENAI_BUF, "", "gpt-4o");
    assert.ok(result !== null);
    assert.equal(result?.format, FORMATS.OPENAI);
  });

  test("a Claude buffer resolves via the seeded Claude fallback", () => {
    const result = parseNonStreamingSSEPayload(CLAUDE_BUF, "", "claude");
    assert.ok(result !== null);
    assert.equal(result?.format, FORMATS.CLAUDE);
  });

  test("a Gemini buffer resolves via the seeded Gemini fallback", () => {
    const result = parseNonStreamingSSEPayload(GEMINI_BUF, "", "gemini-pro");
    assert.ok(result !== null, "the seeded Gemini fallback should have resolved this buffer");
    assert.equal(result?.format, FORMATS.GEMINI);
    assert.equal(
      (result?.body.choices as Array<{ message?: { content?: unknown } }>)[0].message?.content,
      "hi"
    );
  });

  test("the seeded order is tried in full before giving up", () => {
    // A body no seeded parser understands returns null rather than an empty body.
    assert.equal(parseNonStreamingSSEPayload("not an sse body at all", "", "m"), null);
    assert.equal(parseNonStreamingSSEPayload("", "", "m"), null);
  });

  test("a parser returning nothing does not stop the chain — the next format is tried", () => {
    // Preferred format first (which cannot parse this Claude buffer), then the
    // seeded list. Mutant: `if (true)` on the `parsed && typeof parsed === "object"`
    // guard would return the first parser's null instead of falling through.
    const result = parseNonStreamingSSEPayload(CLAUDE_BUF, FORMATS.OPENAI, "claude");
    assert.ok(result !== null);
    assert.equal(result?.format, FORMATS.CLAUDE);
  });
});

describe("shouldTreatBufferedEventResponseAsExpected — one signal at a time", () => {
  test("upstreamStream alone is enough", () => {
    // The other two signals are false here, so this only holds if upstreamStream
    // is OR-ed in rather than AND-ed.
    assert.equal(shouldTreatBufferedEventResponseAsExpected(true, {}, { stream: false }), true);
  });

  test("the accept header alone is enough", () => {
    assert.equal(
      shouldTreatBufferedEventResponseAsExpected(false, { accept: "text/event-stream" }, null),
      true
    );
  });

  test("a stream:true body alone is enough", () => {
    assert.equal(shouldTreatBufferedEventResponseAsExpected(false, {}, { stream: true }), true);
  });

  test("no signal at all means the response is not expected", () => {
    assert.equal(shouldTreatBufferedEventResponseAsExpected(false, {}, { stream: false }), false);
    assert.equal(shouldTreatBufferedEventResponseAsExpected(false, null, null), false);
  });
});

describe("appendNonStreamingSseTerminalSignal — line shape", () => {
  test("a whitespace-padded event: line still sets the pending event", () => {
    // Mutant: drop the per-line trim() -> the padded line is not recognised as an
    // `event:` line, so the Claude stop_reason superset below is never armed.
    const state = freshState();
    const done = appendNonStreamingSseTerminalSignal(
      state,
      '  event: message_delta  \ndata: {"delta":{"stop_reason":"end_turn"}}\n'
    );
    assert.equal(state.currentEvent, "message_delta");
    assert.equal(done, true);
  });

  test("a non-data, non-event field line is skipped without ending the scan", () => {
    // Mutant: the "data:" literal becomes "" so `startsWith("")` is always true
    // and the guard stops rejecting other SSE field lines; the leftover text is
    // then sliced as if it were a data payload.
    const state = freshState();
    const done = appendNonStreamingSseTerminalSignal(
      state,
      "event: response.completed\nretry: 1000\n"
    );
    assert.equal(done, false);
  });

  test("a comment line is ignored and does not end the scan", () => {
    const state = freshState();
    assert.equal(appendNonStreamingSseTerminalSignal(state, ": keep-alive\n"), false);
    assert.equal(state.currentEvent, "");
  });
});

describe("hasClaudeTerminalMessageDelta — reached via the stop_reason superset", () => {
  // These are private helpers, so each case is reached through the public
  // scanner using the only path that parses a delta frame: a pending
  // `message_delta` event plus a payload containing "stop_reason".

  const scanDelta = (data: string) => {
    const state = freshState();
    const done = appendNonStreamingSseTerminalSignal(
      state,
      `event: message_delta\ndata: ${data}\n`
    );
    return done;
  };

  test("a non-string but present stop_reason is terminal", () => {
    // `typeof stopReason === "string" ? ... : stopReason != null` — the
    // non-string branch must accept any present value.
    assert.equal(scanDelta('{"delta":{"stop_reason":123}}'), true);
    assert.equal(scanDelta('{"delta":{"stop_reason":false}}'), true);
  });

  test("an empty stop_reason string is not terminal", () => {
    assert.equal(scanDelta('{"delta":{"stop_reason":""}}'), false);
  });

  test("a missing or null stop_reason is not terminal", () => {
    assert.equal(scanDelta('{"delta":{}}'), false);
    assert.equal(scanDelta('{"delta":{"stop_reason":null}}'), false);
  });

  test("a delta that is not an object is not terminal", () => {
    assert.equal(scanDelta('{"delta":"end_turn"}'), false);
    assert.equal(scanDelta('{"delta":null}'), false);
  });

  test("a message_delta payload whose own type disagrees is judged on that type", () => {
    // hasClaudeTerminalMessageDelta is called with the eventType, which prefers
    // the frame's own `type`. A different type must not be treated as a Claude
    // terminal delta.
    assert.equal(
      scanDelta('{"type":"content_block_delta","delta":{"stop_reason":"end_turn"}}'),
      false
    );
  });
});

describe("hasGeminiTerminalFinishReason — reached via the finishReason superset", () => {
  // Same approach: a top-level candidates[] frame with no `type` field, so the
  // scanner parses it on the "finishReason" superset and consults this helper.

  const scanCandidates = (candidatesJson: string) => {
    const state = freshState();
    return appendNonStreamingSseTerminalSignal(state, `data: {"candidates":${candidatesJson}}\n`);
  };

  test("a non-string finishReason is not terminal", () => {
    assert.equal(scanCandidates('[{"finishReason":123}]'), false);
    assert.equal(scanCandidates('[{"finishReason":null}]'), false);
  });

  test("an empty finishReason string is not terminal", () => {
    assert.equal(scanCandidates('[{"finishReason":""}]'), false);
  });

  test("an empty or missing candidates list is not terminal", () => {
    assert.equal(scanCandidates("[]"), false);
  });

  test("a candidate that is not an object is not terminal", () => {
    assert.equal(scanCandidates('["STOP"]'), false);
    assert.equal(scanCandidates("[null]"), false);
  });

  test("a populated finishReason is terminal", () => {
    assert.equal(scanCandidates('[{"finishReason":"STOP"}]'), true);
    // Only the first candidate is consulted.
    assert.equal(scanCandidates('[{"finishReason":""},{"finishReason":"STOP"}]'), false);
  });
});
