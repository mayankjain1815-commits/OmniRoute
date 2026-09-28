/**
 * Transport / proxy failure classification for provider-limits fetches.
 *
 * Extracted from `providerLimits.ts` (see the note in `isThrownNetworkFailure`
 * below) purely to keep that module under its frozen size cap — the logic is
 * unchanged and is still consumed only by `shouldFailClosedForProviderLimitsProxy`.
 */

/** True for a non-null, non-array object. Local to avoid an import cycle on the shared helper. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNetworkFailureMessage(message: unknown): boolean {
  if (typeof message !== "string") return false;
  return (
    message.includes("fetch failed") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ETIMEDOUT") ||
    message.includes("Proxy unreachable") ||
    message.includes("UND_ERR_CONNECT_TIMEOUT")
  );
}

/** Codes `runWithProxyContext` stamps on a fast-fail, plus the transport codes undici surfaces. */
const PROXY_TRANSPORT_CODES = new Set([
  "PROXY_UNREACHABLE",
  "ECONNREFUSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "ETIMEDOUT",
]);

/**
 * Classify a THROWN error as a transport / proxy failure.
 *
 * This used to be exact-match only: `error.message === "fetch failed"`, a top-level
 * `code`, or a top-level `cause.code`. A provider whose usage module WRAPS the
 * transport error therefore never matched — GitHub's surfaces as
 * `Failed to fetch GitHub usage: fetch failed`, with `.cause` and `.code` dropped
 * on the way out. That happened to be safe, because the unrecognised case falls
 * through to a bare rethrow, but it meant the deliberate fail-closed decision was
 * silently SKIPPED: the account-scoped-proxy egress guarantee rested on the wrapper
 * throwing rather than on the policy that exists to enforce it. Any future change
 * that made the same wrapper return instead of throw would have turned a documented
 * guarantee into an accident.
 *
 * So: substring-match the message with the same vocabulary the `usage.message` check
 * already uses, accept the transport codes case-insensitively, and walk a bounded
 * `cause` chain (plus a Happy-Eyeballs `AggregateError.errors`) so the real reason is
 * found wherever it was parked.
 */
export function isThrownNetworkFailure(error: unknown): boolean {
  if (!isRecord(error)) return false;

  let cursor: unknown = error;
  for (let depth = 0; isRecord(cursor) && depth < 5; depth += 1) {
    if (isNetworkFailureMessage(cursor.message)) return true;

    for (const key of ["code", "errorCode"]) {
      const value = cursor[key];
      if (typeof value === "string" && PROXY_TRANSPORT_CODES.has(value.toUpperCase())) {
        return true;
      }
    }

    const aggregate = cursor.errors;
    if (Array.isArray(aggregate) && aggregate.some((entry) => isThrownNetworkFailure(entry))) {
      return true;
    }

    cursor = cursor.cause;
  }

  return false;
}
