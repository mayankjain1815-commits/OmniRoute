/**
 * Branch-coverage companion to chatcore-passthrough-tool-names.test.ts.
 *
 * The mutation ratchet (Nightly Mutation) reported this module at 60.38
 * against a 66.42 baseline, and the gap was structural rather than subtle:
 * `restoreNonStreamingToolNames` and `normalizeOpenAIToolFinishReasons` were
 * exported but imported by no test at all, and the three tested functions
 * asserted only their happy paths. The branch conditions below each guard a
 * distinct early return, so removing any one of them would silently change
 * behaviour that no existing assertion pins down.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildClaudePassthroughToolNameMap,
  restoreClaudePassthroughToolNames,
  mergeResponseToolNameMap,
  restoreNonStreamingToolNames,
  normalizeOpenAIToolFinishReasons,
} from "../../open-sse/handlers/chatCore/passthroughToolNames.ts";
import { CLAUDE_OAUTH_TOOL_PREFIX } from "../../open-sse/translator/request/openai-to-claude.ts";

const P = CLAUDE_OAUTH_TOOL_PREFIX; // "proxy_"

test("buildClaudePassthroughToolNameMap returns null when tools is not an array", () => {
  // Guards `!Array.isArray(body.tools)`. A non-array `tools` must not be
  // iterated, and must not throw.
  assert.equal(buildClaudePassthroughToolNameMap({ tools: "not-an-array" }), null);
  assert.equal(buildClaudePassthroughToolNameMap({ tools: { name: "x" } }), null);
  assert.equal(buildClaudePassthroughToolNameMap({}), null);
});

test("buildClaudePassthroughToolNameMap reads a bare tool object when type is not function", () => {
  // Guards the ternary at the `type === "function"` check: a tool shaped as a
  // flat `{ name }` (no `function` wrapper) must still be mapped.
  const map = buildClaudePassthroughToolNameMap({ tools: [{ name: "flat_tool" }] });
  assert.ok(map);
  assert.equal(map?.get(`${P}flat_tool`), "flat_tool");
});

test("buildClaudePassthroughToolNameMap falls back to the tool record when function is not an object", () => {
  // Guards `typeof toolRecord.function === "object"`. `function` present but a
  // string means the name has to be read off the outer record instead.
  const map = buildClaudePassthroughToolNameMap({
    tools: [{ type: "function", function: "oops", name: "outer_name" }],
  });
  assert.ok(map);
  assert.equal(map?.get(`${P}outer_name`), "outer_name");
});

test("buildClaudePassthroughToolNameMap skips blank and non-string names", () => {
  // Guards `!originalName`, which combines the trim() and the typeof checks.
  // A whitespace-only name trims to "" and must be skipped rather than mapped
  // to an empty original name.
  const map = buildClaudePassthroughToolNameMap({
    tools: [{ name: "   " }, { name: 123 }, { name: "kept" }],
  });
  assert.ok(map);
  assert.equal(map?.size, 1);
  assert.equal(map?.get(`${P}kept`), "kept");
  // And a tools array where every entry is skipped still yields null.
  assert.equal(buildClaudePassthroughToolNameMap({ tools: [{ name: "  " }] }), null);
});

test("restoreClaudePassthroughToolNames returns the body untouched when content is not an array", () => {
  // Guards `!Array.isArray(responseBody?.content)`.
  const body = { content: "nope" };
  assert.equal(restoreClaudePassthroughToolNames(body, new Map([["a", "b"]])), body);
  const noContent: Record<string, unknown> = {};
  assert.equal(restoreClaudePassthroughToolNames(noContent, new Map([["a", "b"]])), noContent);
});

test("restoreClaudePassthroughToolNames leaves non-tool_use and unnamed blocks alone", () => {
  // Guards the `block?.type !== "tool_use" || typeof block?.name !== "string"`
  // early return: a text block, and a tool_use block with a non-string name,
  // must both pass through without being rewritten.
  const map = new Map([[`${P}x`, "x"]]);
  const body = {
    content: [
      { type: "text", text: "hello" },
      { type: "tool_use", name: 42 },
    ],
  };
  const out = restoreClaudePassthroughToolNames(body, map) as typeof body;
  // `changed` stays false, so the original object is returned by identity.
  assert.equal(out, body);
  assert.equal(out.content[0].type, "text");
  assert.equal(out.content[1].name, 42);
});

test("restoreClaudePassthroughToolNames keeps the original name when unmapped", () => {
  // Guards `toolNameMap.get(block.name) ?? block.name` and the
  // `restoredName === block.name` identity return: a prefixed name that is NOT
  // in the map has nothing to restore, so the block must be left as-is.
  const map = new Map([[`${P}x`, "x"]]);
  const body = { content: [{ type: "tool_use", name: `${P}unknown` }] };
  const out = restoreClaudePassthroughToolNames(body, map) as typeof body;
  assert.equal(out, body);
  assert.equal(out.content[0].name, `${P}unknown`);
});

test("mergeResponseToolNameMap ignores a non-object or array transformedBody", () => {
  // Guards the `!Array.isArray(transformedBody)` half of the record check: an
  // array is an object but has no `_toolNameMap`, so it must not be consulted.
  const base = new Map([["a", "1"]]);
  for (const body of [null, undefined, "str", 42, [], [{ _toolNameMap: new Map([["b", "2"]]) }]]) {
    assert.equal(mergeResponseToolNameMap(base, body), base);
  }
});

test("mergeResponseToolNameMap ignores a _toolNameMap that is not a Map", () => {
  // Guards `instanceof Map`. A plain object or array with the right key must
  // not be treated as an alias map.
  const base = new Map([["a", "1"]]);
  assert.equal(mergeResponseToolNameMap(base, { _toolNameMap: { b: "2" } }), base);
  assert.equal(mergeResponseToolNameMap(base, { _toolNameMap: [["b", "2"]] }), base);

  // A Set is the case that actually discriminates the guard. It has a truthy
  // `.size` and an `.entries()` method, so a truthiness-only check would let it
  // through -- and because Set#entries yields [value, value] pairs, the merge
  // loop would then pollute the alias map with self-mapping garbage
  // ("b" -> "b", "2" -> "2"). `instanceof Map` is what rejects it.
  const asSet = new Set(["b", "2"]);
  const guarded = mergeResponseToolNameMap(base, { _toolNameMap: asSet });
  assert.equal(guarded, base);
  assert.equal((guarded as Map<string, string>).size, 1);
  assert.equal((guarded as Map<string, string>).has("b"), false);
});

test("mergeResponseToolNameMap treats an empty executor map as absent", () => {
  // Guards `!executorToolNameMap?.size`: an empty Map carries no aliases, so the
  // base map must be returned unchanged rather than a needless copy.
  const base = new Map([["a", "1"]]);
  assert.equal(mergeResponseToolNameMap(base, { _toolNameMap: new Map() }), base);
});

test("mergeResponseToolNameMap returns the executor map when there is no base", () => {
  // Guards `!baseToolNameMap?.size`, in both its null and its empty forms.
  const exec = new Map([["b", "2"]]);
  assert.equal(mergeResponseToolNameMap(null, { _toolNameMap: exec }), exec);
  assert.equal(mergeResponseToolNameMap(new Map(), { _toolNameMap: exec }), exec);
  // With no executor map at all the base is returned untouched -- including a
  // null base, and an empty base that stays the very same empty Map (not a copy).
  assert.equal(mergeResponseToolNameMap(null, {}), null);
  const emptyBase = new Map();
  assert.equal(mergeResponseToolNameMap(emptyBase, {}), emptyBase);
});

test("mergeResponseToolNameMap does not mutate the base map while merging", () => {
  // `new Map(baseToolNameMap)` is a copy. Asserting the base is untouched
  // pins that copy, so replacing it with the base itself would be caught.
  const base = new Map([["a", "1"]]);
  mergeResponseToolNameMap(base, { _toolNameMap: new Map([["b", "2"]]) });
  assert.equal(base.size, 1);
  assert.equal(base.has("b"), false);
});

test("restoreNonStreamingToolNames returns the merged map and rewrites OpenAI names", () => {
  // Previously imported by no test. With restoreClaudeNames=false the body is
  // passed through untouched, while restoreOpenAIToolNames still rewrites the
  // aliased function name inside choices[].message.tool_calls.
  const body = {
    choices: [{ message: { tool_calls: [{ function: { name: `${P}lookup` } }] } }],
  };
  const [out, map] = restoreNonStreamingToolNames(
    body,
    new Map([[`${P}lookup`, "lookup"]]),
    {},
    false
  );
  assert.equal(map?.get(`${P}lookup`), "lookup");
  const choice = (
    out as { choices: { message: { tool_calls: { function: { name: string } }[] }[] } }
  ).choices[0];
  assert.equal(choice.message.tool_calls[0].function.name, "lookup");
});

test("restoreNonStreamingToolNames applies the Claude restore only when asked", () => {
  // Pins the `restoreClaudeNames ? ... : responseBody` ternary in both
  // directions: with the flag on, tool_use block names are restored; with it
  // off, the identical input comes back with the prefix still in place.
  const makeBody = () => ({ content: [{ type: "tool_use", name: `${P}calc` }] });
  const map = new Map([[`${P}calc`, "calc"]]);

  const [on] = restoreNonStreamingToolNames(makeBody(), map, {}, true);
  assert.equal((on as { content: { name: string }[] }).content[0].name, "calc");

  const [off] = restoreNonStreamingToolNames(makeBody(), map, {}, false);
  assert.equal((off as { content: { name: string }[] }).content[0].name, `${P}calc`);
});

test("restoreNonStreamingToolNames threads the executor map into the returned map", () => {
  // The returned map is the *merged* one, not the base. This is the wiring the
  // Responses path depends on: the executor's own aliases must reach the
  // restore step, otherwise prefixed names leak to the client.
  const [, map] = restoreNonStreamingToolNames(
    { choices: [] },
    new Map([["base", "b"]]),
    { _toolNameMap: new Map([["exec", "e"]]) },
    false
  );
  assert.equal(map?.get("base"), "b");
  assert.equal(map?.get("exec"), "e");
});

test("normalizeOpenAIToolFinishReasons promotes a tool_calls finish_reason", () => {
  // Previously imported by no test. A choice that already streamed tool calls
  // but reports finish_reason "stop" must be corrected to "tool_calls".
  const body = {
    choices: [{ message: { tool_calls: [{ function: { name: "a" } }] }, finish_reason: "stop" }],
  };
  normalizeOpenAIToolFinishReasons(body);
  assert.equal(
    (body as { choices: { finish_reason: string }[] }).choices[0].finish_reason,
    "tool_calls"
  );
});

test("normalizeOpenAIToolFinishReasons leaves other finish reasons and shapes alone", () => {
  // Guards the two early exits: no choices at all, and choices whose tool_calls
  // array is empty. Both must leave finish_reason untouched.
  for (const body of [null, undefined, {}, { choices: null }, { choices: [] }, { choices: [{}] }]) {
    assert.doesNotThrow(() => normalizeOpenAIToolFinishReasons(body));
  }
  const noCalls = { choices: [{ message: { tool_calls: [] }, finish_reason: "stop" }] };
  normalizeOpenAIToolFinishReasons(noCalls);
  assert.equal(
    (noCalls as { choices: { finish_reason: string }[] }).choices[0].finish_reason,
    "stop"
  );

  // An already-correct value must not be rewritten (idempotent).
  const correct = {
    choices: [
      { message: { tool_calls: [{ function: { name: "a" } }] }, finish_reason: "tool_calls" },
    ],
  };
  normalizeOpenAIToolFinishReasons(correct);
  assert.equal(
    (correct as { choices: { finish_reason: string }[] }).choices[0].finish_reason,
    "tool_calls"
  );

  // A choice with no message at all is skipped rather than throwing.
  const noMessage = { choices: [{ finish_reason: "stop" }] };
  assert.doesNotThrow(() => normalizeOpenAIToolFinishReasons(noMessage));
  assert.equal(
    (noMessage as { choices: { finish_reason: string }[] }).choices[0].finish_reason,
    "stop"
  );
});
