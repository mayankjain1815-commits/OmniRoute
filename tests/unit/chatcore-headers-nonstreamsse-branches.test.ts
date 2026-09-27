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
  type NonStreamingSseTerminalState,
} from "../../open-sse/handlers/chatCore/nonStreamingSse.ts";

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
