import test from "node:test";
import assert from "node:assert/strict";
import { isThrownNetworkFailure } from "../../src/lib/usage/providerLimitsTransport.ts";

/**
 * `isThrownNetworkFailure` decides whether a THROWN error counts as a transport /
 * proxy failure, which is what arms the fail-closed path for account-scoped proxy
 * resolution in `src/lib/usage/providerLimits.ts`.
 *
 * The regression this guards: the classifier used to be exact-match only
 * (`message === "fetch failed"`, a top-level `code`, a top-level `cause.code`). A
 * provider whose usage module WRAPS the transport error therefore never matched,
 * so the deliberate fail-closed decision was silently skipped and the
 * account-scoped-proxy egress guarantee rested on the wrapper throwing rather
 * than on the policy meant to enforce it.
 */

/**
 * Build a cause chain of `depth` wrappers where ONLY the deepest link carries the
 * code, so a test can park the real reason at a chosen depth and prove the walk's
 * bound. `depth: 0` returns the error unchanged.
 */
function withCause(error: Error, code: string, depth: number): Error {
  let cursor: Error & { cause?: unknown } = error;
  for (let i = 1; i <= depth; i += 1) {
    const next: Error & { cause?: unknown; code?: string } = new Error(`wrap ${i}`);
    if (i === depth) next.code = code;
    cursor.cause = next;
    cursor = next;
  }
  return error;
}

test("matches a bare undici transport error", () => {
  assert.equal(isThrownNetworkFailure(new TypeError("fetch failed")), true);
});

test("matches a proxy fast-fail by code alone", () => {
  assert.equal(isThrownNetworkFailure({ code: "PROXY_UNREACHABLE" }), true);
});

test("REGRESSION: matches a transport error a provider module WRAPPED", () => {
  // GitHub's usage surface throws this exact shape: the original message is
  // interpolated into a new one and `.cause` / `.code` are dropped on the way out.
  assert.equal(
    isThrownNetworkFailure(new Error("Failed to fetch GitHub usage: fetch failed")),
    true
  );
  assert.equal(isThrownNetworkFailure(new Error("usage sync: ECONNREFUSED")), true);
  assert.equal(isThrownNetworkFailure(new Error("proxy: UND_ERR_CONNECT_TIMEOUT")), true);
});

test("REGRESSION: matches when the real reason is buried in a cause chain", () => {
  const wrapped = withCause(new Error("Failed to fetch usage: request failed"), "ETIMEDOUT", 2);
  assert.equal(isThrownNetworkFailure(wrapped), true);
});

test("REGRESSION: matches a Happy-Eyeballs AggregateError", () => {
  const aggregate = Object.assign(new Error("all connections failed"), {
    errors: [new Error("connect ECONNREFUSED 127.0.0.1:9")],
  });
  assert.equal(isThrownNetworkFailure(aggregate), true);
});

test("accepts the transport codes case-insensitively", () => {
  for (const code of [
    "proxy_unreachable",
    "Econnrefused",
    "und_err_connect_timeout",
    "etimedout",
  ]) {
    assert.equal(isThrownNetworkFailure({ code }), true, `expected ${code} to match`);
  }
});

test("rejects errors that are not transport failures", () => {
  assert.equal(isThrownNetworkFailure(new Error("401 Unauthorized")), false);
  assert.equal(isThrownNetworkFailure(new Error("quota exceeded")), false);
  assert.equal(isThrownNetworkFailure({ code: "ENOTFOUND" }), false);
});

test("rejects non-object inputs", () => {
  for (const value of [null, undefined, "fetch failed", 42, true, [new Error("fetch failed")]]) {
    assert.equal(isThrownNetworkFailure(value), false, `expected ${String(value)} to be false`);
  }
});

test("stops walking the cause chain at its bound", () => {
  // Only the deepest link carries the code. depth 4 is the last cursor the walk
  // reaches (`depth < 5`); depth 5 is one past the bound.
  assert.equal(isThrownNetworkFailure(withCause(new Error("outer"), "ECONNREFUSED", 4)), true);
  assert.equal(isThrownNetworkFailure(withCause(new Error("outer"), "ECONNREFUSED", 5)), false);
});

test("a network code in an AggregateError sibling still matches", () => {
  const aggregate = Object.assign(new Error("aggregate"), {
    errors: [new Error("dns"), { code: "PROXY_UNREACHABLE" }],
  });
  assert.equal(isThrownNetworkFailure(aggregate), true);
});
