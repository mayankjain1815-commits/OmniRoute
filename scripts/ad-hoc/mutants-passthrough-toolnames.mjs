#!/usr/bin/env node
/**
 * Mutation check for the passthroughToolNames branch tests.
 *
 * Rewrites one guard in open-sse/handlers/chatCore/passthroughToolNames.ts at a
 * time (via a temp copy that is restored immediately after), runs the new suite,
 * and reports which mutants the suite fails to detect. Anything reported as
 * "SURVIVED" is a guard the tests do not actually pin.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = "/private/var/folders/bp/sj98r3wj7dv6hkt3flyhlhh00000gn/T/opencode/OmniRoute-ci-fix";
const TARGET = path.join(ROOT, "open-sse/handlers/chatCore/passthroughToolNames.ts");
const SUITE = "tests/unit/chatcore-passthrough-tool-names-branches.test.ts";

const original = fs.readFileSync(TARGET, "utf8");

/** Each mutant: a literal that must appear, and the broken replacement. */
const MUTANTS = [
  {
    name: "buildClaude: drop !Array.isArray(body.tools) guard",
    find: "if (!body || !Array.isArray(body.tools)) return null;",
    replace: "if (!body) return null;",
  },
  {
    name: "buildClaude: never skip blank/non-string names",
    find: "if (!originalName) continue;",
    replace: "if (false) continue;",
  },
  {
    name: "buildClaude: always return the map, even when empty",
    find: "return toolNameMap.size > 0 ? toolNameMap : null;",
    replace: "return toolNameMap;",
  },
  {
    name: "restoreClaude: drop !Array.isArray(content) guard",
    find: "if (!toolNameMap || !Array.isArray(responseBody?.content)) return responseBody;",
    replace: "if (!toolNameMap) return responseBody;",
  },
  {
    name: "restoreClaude: rewrite every tool_use block, mapped or not",
    find: "if (restoredName === block.name) return block;",
    replace: "if (false) return block;",
  },
  {
    name: "restoreClaude: always allocate a new body",
    find: "if (!changed) return responseBody;",
    replace: "if (false) return responseBody;",
  },
  {
    name: "merge: accept a non-Map _toolNameMap",
    find: "transformedRecord?._toolNameMap instanceof Map",
    replace: "transformedRecord?._toolNameMap != null",
  },
  {
    name: "merge: treat an empty executor map as present",
    find: "if (!executorToolNameMap?.size) return baseToolNameMap;",
    replace: "if (!executorToolNameMap) return baseToolNameMap;",
  },
  {
    name: "merge: mutate the base map instead of copying it",
    find: "const merged = new Map(baseToolNameMap);",
    replace: "const merged = baseToolNameMap;",
  },
  {
    name: "restoreNonStreaming: ignore the restoreClaudeNames flag",
    find: "restoreClaudeNames\n    ? restoreClaudePassthroughToolNames(responseBody, responseToolNameMap)",
    replace: "true\n    ? restoreClaudePassthroughToolNames(responseBody, responseToolNameMap)",
  },
  {
    name: "normalizeFinishReasons: drop the !response?.choices guard",
    find: "if (!response?.choices) return;",
    replace: "if (!response) return;",
  },
  {
    name: "normalizeFinishReasons: overwrite an already-correct value",
    find: 'choice.message?.tool_calls?.length > 0 && choice.finish_reason !== "tool_calls"',
    replace: "choice.message?.tool_calls?.length > 0",
  },
];

const runSuite = () => {
  try {
    execFileSync("node", ["--import", "tsx/esm", "--test", SUITE], {
      cwd: ROOT,
      stdio: "pipe",
      encoding: "utf8",
    });
    return { failed: false };
  } catch (err) {
    return { failed: true, out: `${err.stdout || ""}${err.stderr || ""}` };
  }
};

const baseline = runSuite();
console.log(`\n  baseline (unmutated): ${baseline.failed ? "FAILING" : "passes"}`);
if (baseline.failed) {
  console.log("  refusing to score mutants against a failing baseline\n");
  process.exit(1);
}

let killed = 0;
const survivors = [];

for (const m of MUTANTS) {
  if (!original.includes(m.find)) {
    console.log(`  SKIP    ${m.name} (anchor not found — update the mutant)`);
    continue;
  }
  const mutated = original.replace(m.find, m.replace);
  fs.writeFileSync(TARGET, mutated);
  let result;
  try {
    result = runSuite();
  } finally {
    fs.writeFileSync(TARGET, original);
  }
  if (result.failed) {
    killed++;
    console.log(`  killed  ${m.name}`);
  } else {
    survivors.push(m.name);
    console.log(`  SURVIVED ${m.name}`);
  }
}

fs.writeFileSync(TARGET, original);
console.log(`\n  ${killed}/${MUTANTS.length} mutants killed, ${survivors.length} survived`);
if (survivors.length) {
  console.log("  survivors (tests do not pin these guards):");
  for (const s of survivors) console.log(`    - ${s}`);
}
console.log(`  source restored: ${fs.readFileSync(TARGET, "utf8") === original ? "yes" : "NO"}\n`);
