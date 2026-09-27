/**
 * Mutation harness for the two modules still regressed against their
 * `quality-baseline.json` floors:
 *
 *   open-sse/handlers/chatCore/headers.ts          92.59 observed / 94.29 floor
 *   open-sse/handlers/chatCore/nonStreamingSse.ts  70.67 observed / 72.82 floor
 *
 * Each entry rewrites one guard/operator in the source, runs the covering
 * node:test files, and restores the original bytes in a `finally` block. A
 * mutant is KILLED when the suite goes red; a mutant that stays green SURVIVES
 * and names a branch the tests do not actually assert.
 *
 * Exits 0 when the baseline (unmutated) suite is green, regardless of how many
 * mutants survive — survivors are the useful output, not a gate failure. This
 * is a diagnostic tool, not a CI gate (the real gate is
 * `check-mutation-ratchet.mjs`).
 *
 * Usage: node --import tsx/esm scripts/ad-hoc/mutants-headers-nonstreamsse.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const HEADERS = join(ROOT, "open-sse/handlers/chatCore/headers.ts");
const NONSSE = join(ROOT, "open-sse/handlers/chatCore/nonStreamingSse.ts");

const HEADER_TESTS = [
  "tests/unit/chatcore-headers-nonstreamsse-branches.test.ts",
  "tests/unit/chatcore-headers.test.ts",
  "tests/unit/no-memory-header.test.ts",
  "tests/unit/strip-reasoning-header.test.ts",
];
const NONSSE_TESTS = [
  "tests/unit/chatcore-headers-nonstreamsse-branches.test.ts",
  "tests/unit/chatcore-non-streaming-sse.test.ts",
  "tests/unit/non-streaming-sse-terminal-typescan-4459.test.ts",
];

/** @type {{name:string,file:string,from:string,to:string,tests:string[]}[]} */
const MUTANTS = [
  // ── headers.ts :: getHeaderValueCaseInsensitive ───────────────────────────
  {
    name: "headers: drop the `typeof headers !== object` half of the guard",
    file: HEADERS,
    from: `if (!headers || typeof headers !== "object") return null;`,
    to: `if (!headers) return null;`,
    tests: HEADER_TESTS,
  },
  {
    name: "headers: drop the `instanceof Headers` fast path",
    file: HEADERS,
    from: `  if (headers instanceof Headers) {
    return headers.get(targetName);
  }`,
    to: `  if (false) {
    return headers.get(targetName);
  }`,
    tests: HEADER_TESTS,
  },
  {
    name: "headers: make the key comparison case-SENSITIVE",
    file: HEADERS,
    from: `    if (key.toLowerCase() === lowered && typeof value === "string" && value.trim()) {`,
    to: `    if (key === targetName && typeof value === "string" && value.trim()) {`,
    tests: HEADER_TESTS,
  },
  {
    name: "headers: drop the `typeof value === string` guard",
    file: HEADERS,
    from: `    if (key.toLowerCase() === lowered && typeof value === "string" && value.trim()) {`,
    to: `    if (key.toLowerCase() === lowered && value.trim()) {`,
    tests: HEADER_TESTS,
  },
  {
    name: "headers: accept blank/whitespace-only header values",
    file: HEADERS,
    from: `    if (key.toLowerCase() === lowered && typeof value === "string" && value.trim()) {`,
    to: `    if (key.toLowerCase() === lowered && typeof value === "string") {`,
    tests: HEADER_TESTS,
  },
  {
    name: "headers: return the raw value instead of the trimmed one",
    file: HEADERS,
    from: `      return value.trim();`,
    to: `      return value;`,
    tests: HEADER_TESTS,
  },
  {
    name: 'headers: return "" instead of null when the header is absent',
    file: HEADERS,
    from: `  return null;
}`,
    to: `  return "";
}`,
    tests: HEADER_TESTS,
  },

  // ── headers.ts :: isNoMemoryRequested ─────────────────────────────────────
  {
    name: "noMemory: `||` → `&&` across the truthy set",
    file: HEADERS,
    from: `  return value === "true" || value === "1" || value === "yes";
}

/**
 * Per-request compression override`,
    to: `  return value === "true" && value === "1" && value === "yes";
}

/**
 * Per-request compression override`,
    tests: HEADER_TESTS,
  },
  {
    name: 'noMemory: drop the "1" truthy token',
    file: HEADERS,
    from: `  return value === "true" || value === "1" || value === "yes";
}

/**
 * Per-request compression override`,
    to: `  return value === "true" || value === "yes";
}

/**
 * Per-request compression override`,
    tests: HEADER_TESTS,
  },
  {
    name: "noMemory: drop the toLowerCase() (case-insensitivity)",
    file: HEADERS,
    from: `  const value = (getHeaderValueCaseInsensitive(headers, "x-omniroute-no-memory") || "")
    .trim()
    .toLowerCase();`,
    to: `  const value = (getHeaderValueCaseInsensitive(headers, "x-omniroute-no-memory") || "").trim();`,
    tests: HEADER_TESTS,
  },
  {
    name: 'noMemory: drop the `|| ""` null-guard (throws on absent header)',
    file: HEADERS,
    from: `  const value = (getHeaderValueCaseInsensitive(headers, "x-omniroute-no-memory") || "")
    .trim()
    .toLowerCase();`,
    to: `  const value = (getHeaderValueCaseInsensitive(headers, "x-omniroute-no-memory") as string)
    .trim()
    .toLowerCase();`,
    tests: HEADER_TESTS,
  },

  // ── headers.ts :: resolveCompressionHeader ────────────────────────────────
  {
    name: "compression: return the blank string instead of null",
    file: HEADERS,
    from: `  const value = (getHeaderValueCaseInsensitive(headers, "x-omniroute-compression") || "").trim();
  return value || null;`,
    to: `  const value = (getHeaderValueCaseInsensitive(headers, "x-omniroute-compression") || "").trim();
  return value;`,
    tests: HEADER_TESTS,
  },
  {
    name: "compression: drop the trim()",
    file: HEADERS,
    from: `  const value = (getHeaderValueCaseInsensitive(headers, "x-omniroute-compression") || "").trim();`,
    to: `  const value = getHeaderValueCaseInsensitive(headers, "x-omniroute-compression") || "";`,
    tests: HEADER_TESTS,
    // Equivalent mutant, provably. getHeaderValueCaseInsensitive returns either
    // null or `value.trim()` — an already-trimmed string — and never anything
    // else. So the candidate expression evaluates to, exhaustively:
    //   null            -> (null || "")        -> ""  -> "".trim()  === ""
    //   "gzip"          -> ("gzip" || "")      -> "gzip" -> "gzip".trim() === "gzip"
    //   "gzip" (padded) -> ("gzip".trim())     -> "gzip" -> "gzip".trim() === "gzip"
    // `.trim()` is the identity function on all three, so no input can
    // distinguish the mutant from the original. Recorded so the survivor count
    // reads as "one unkillable equivalent", not "one coverage gap".
    equivalent:
      "getHeaderValueCaseInsensitive returns null or an already-trimmed string; .trim() is identity on both",
  },

  // ── headers.ts :: isStripReasoningRequested ───────────────────────────────
  {
    name: "stripReasoning: `||` → `&&` across the truthy set",
    file: HEADERS,
    from: `  return value === "true" || value === "1" || value === "yes";
}`,
    to: `  return value === "true" && value === "1" && value === "yes";
}`,
    tests: HEADER_TESTS,
  },
  {
    name: 'stripReasoning: drop the "yes" truthy token',
    file: HEADERS,
    from: `  return value === "true" || value === "1" || value === "yes";
}`,
    to: `  return value === "true" || value === "1";
}`,
    tests: HEADER_TESTS,
  },

  // ── nonStreamingSse.ts :: convertNDJSONToSSE ──────────────────────────────
  {
    name: "ndjson: drop the per-line trim()",
    file: NONSSE,
    from: `    .map((line) => line.trim())
    .filter((line) => line.length > 0);`,
    to: `    .map((line) => line)
    .filter((line) => line.trim().length > 0);`,
    tests: NONSSE_TESTS,
  },
  {
    name: "ndjson: keep blank lines instead of filtering them",
    file: NONSSE,
    from: `    .filter((line) => line.length > 0);`,
    to: `    .filter(() => true);`,
    tests: NONSSE_TESTS,
  },
  {
    name: "ndjson: drop the empty-body early return",
    file: NONSSE,
    from: `  if (chunks.length === 0) return rawBody;`,
    to: `  if (chunks.length === 0) return "";`,
    tests: NONSSE_TESTS,
  },

  // ── nonStreamingSse.ts :: normalizeNonStreamingEventPayload ───────────────
  {
    name: "normalize: ignore the ndjson content-type branch",
    file: NONSSE,
    from: `  if (contentType.includes("application/x-ndjson")) {`,
    to: `  if (false) {`,
    tests: NONSSE_TESTS,
  },

  // ── nonStreamingSse.ts :: isTruthyStreamBody ──────────────────────────────
  {
    name: "truthyStream: accept any truthy body (drop the stream===true check)",
    file: NONSSE,
    from: `  return !!body && typeof body === "object" && (body as { stream?: unknown }).stream === true;`,
    to: `  return !!body;`,
    tests: NONSSE_TESTS,
  },
  {
    name: "truthyStream: drop the typeof-object guard",
    file: NONSSE,
    from: `  return !!body && typeof body === "object" && (body as { stream?: unknown }).stream === true;`,
    to: `  return !!body && (body as { stream?: unknown }).stream === true;`,
    tests: NONSSE_TESTS,
  },

  // ── nonStreamingSse.ts :: isEventStreamAccepted ───────────────────────────
  {
    name: "accept: drop the toLowerCase() (case-insensitive accept)",
    file: NONSSE,
    from: `  return (getHeaderValueCaseInsensitive(headers, "accept") || "")
    .toLowerCase()
    .includes("text/event-stream");`,
    to: `  return (getHeaderValueCaseInsensitive(headers, "accept") || "").includes("text/event-stream");`,
    tests: NONSSE_TESTS,
  },

  // ── nonStreamingSse.ts :: shouldTreatBufferedEventResponseAsExpected ───────
  {
    name: "expected: `||` → `&&` across the three signals",
    file: NONSSE,
    from: `  return upstreamStream || isEventStreamAccepted(providerHeaders) || isTruthyStreamBody(finalBody);`,
    to: `  return upstreamStream && isEventStreamAccepted(providerHeaders) && isTruthyStreamBody(finalBody);`,
    tests: NONSSE_TESTS,
  },

  // ── nonStreamingSse.ts :: processNonStreamingSseTerminalLine ──────────────
  {
    name: "terminal: treat a `:` comment line as a non-terminal even after a terminal event",
    file: NONSSE,
    from: `  if (!trimmed || trimmed.startsWith(":")) {
    const terminalEventOnly = !trimmed && isNonStreamingSseTerminalType(state.currentEvent);`,
    to: `  if (!trimmed || trimmed.startsWith(":")) {
    const terminalEventOnly = false;`,
    tests: NONSSE_TESTS,
  },
  {
    name: "terminal: stop clearing currentEvent on a blank line",
    file: NONSSE,
    from: `    if (!trimmed) state.currentEvent = "";`,
    to: `    if (!trimmed) state.currentEvent = state.currentEvent;`,
    tests: NONSSE_TESTS,
  },
  {
    name: "terminal: drop the `event:` line handler",
    file: NONSSE,
    from: `  if (trimmed.startsWith("event:")) {`,
    to: `  if (false) {`,
    tests: NONSSE_TESTS,
  },
  {
    name: "terminal: drop the `[DONE]` sentinel check",
    file: NONSSE,
    from: `  if (data === "[DONE]") return true;`,
    to: `  if (data === "[DONE__never__]") return true;`,
    tests: NONSSE_TESTS,
  },
  {
    name: "terminal: drop the empty-data guard",
    file: NONSSE,
    from: `  if (!data) return false;`,
    to: `  if (!data) return true;`,
    tests: NONSSE_TESTS,
  },
  {
    name: 'terminal: the "finishReason" superset no longer triggers a parse',
    file: NONSSE,
    from: `    !data.includes('"finishReason"') &&`,
    to: `    true &&`,
    tests: NONSSE_TESTS,
  },
  {
    name: "terminal: the message_delta/stop_reason superset no longer triggers a parse",
    file: NONSSE,
    from: `    !(state.currentEvent === "message_delta" && data.includes("stop_reason"))`,
    to: `    true`,
    tests: NONSSE_TESTS,
  },
  {
    name: "terminal: malformed JSON is treated as terminal instead of skipped",
    file: NONSSE,
    from: `  } catch {
    // Keep reading malformed data so the parser can report a useful upstream error.
    return false;
  }`,
    to: `  } catch {
    return true;
  }`,
    tests: NONSSE_TESTS,
  },
  {
    name: "terminal: eventType prefers state.currentEvent over parsed.type",
    file: NONSSE,
    from: `    const eventType =
      parsed && typeof parsed === "object" && typeof parsed.type === "string"
        ? parsed.type
        : state.currentEvent;`,
    to: `    const eventType = state.currentEvent;`,
    tests: NONSSE_TESTS,
  },

  // ── nonStreamingSse.ts :: appendNonStreamingSseTerminalSignal ─────────────
  {
    name: "append: drop the trailing-line carry-over (pendingLine)",
    file: NONSSE,
    from: `  const lines = \`\${state.pendingLine}\${chunk}\`.split(/\\r?\\n/);
  state.pendingLine = lines.pop() ?? "";`,
    to: `  const lines = chunk.split(/\\r?\\n/);
  state.pendingLine = "";`,
    tests: NONSSE_TESTS,
  },
  {
    name: "append: return true on the last line instead of only on terminal lines",
    file: NONSSE,
    from: `  for (const rawLine of lines) {
    if (processNonStreamingSseTerminalLine(state, rawLine)) return true;
  }

  return false;`,
    to: `  for (const rawLine of lines) {
    processNonStreamingSseTerminalLine(state, rawLine);
  }

  return lines.length > 0;`,
    tests: NONSSE_TESTS,
  },
];

function runSuite(tests) {
  try {
    execFileSync(process.execPath, ["--import", "tsx/esm", "--test", ...tests], {
      cwd: ROOT,
      stdio: "pipe",
      encoding: "utf8",
    });
    return { ok: true, out: "" };
  } catch (err) {
    return { ok: false, out: `${err.stdout || ""}${err.stderr || ""}` };
  }
}

// Baseline: the unmutated suite must be green, otherwise every "survivor" is noise.
const base = runSuite([...new Set(MUTANTS.flatMap((m) => m.tests))]);
console.log(`  baseline suite green      : ${base.ok}`);
if (!base.ok) {
  console.log("  refusing to mutate against a red baseline — fix the suite first.");
  process.exit(1);
}
console.log();

const survivors = [];
const equivalents = [];
const killed = [];

for (const m of MUTANTS) {
  const original = readFileSync(m.file, "utf8");
  if (!original.includes(m.from)) {
    survivors.push({ ...m, note: "ANCHOR NOT FOUND — harness is stale vs. the source" });
    continue;
  }
  writeFileSync(m.file, original.replace(m.from, m.to));
  let res;
  try {
    res = runSuite(m.tests);
  } finally {
    writeFileSync(m.file, original);
  }
  if (res.ok) {
    if (m.equivalent) equivalents.push(m);
    else survivors.push(m);
  } else killed.push(m);
}

for (const m of killed) console.log(`  KILLED      ${m.name}`);
console.log();
for (const m of equivalents) {
  console.log(`  EQUIVALENT  ${m.name}`);
  console.log(`              unkillable by construction: ${m.equivalent}`);
}
if (equivalents.length) console.log();
for (const m of survivors) {
  console.log(`  SURVIVED    ${m.name}${m.note ? ` [${m.note}]` : ""}`);
}

console.log();
console.log(
  `  killed ${killed.length}/${MUTANTS.length}` +
    (equivalents.length ? `   equivalent ${equivalents.length}` : "") +
    (survivors.length ? `   SURVIVED ${survivors.length}` : "")
);
console.log(
  survivors.length
    ? "\n  Surviving mutants name branches the tests never assert — add a test per line above.\n"
    : "\n  Every killable mutant is killed; the only survivors are provably equivalent.\n"
);
