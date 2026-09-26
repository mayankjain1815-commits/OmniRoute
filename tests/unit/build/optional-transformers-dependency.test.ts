import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();

function readJson<T = Record<string, unknown>>(relPath: string): T {
  return JSON.parse(readFileSync(join(repoRoot, relPath), "utf8")) as T;
}

const TRANSFORMERS = "@huggingface/transformers";

/**
 * Assert the locked version is consistent with the range declared in
 * package.json.
 *
 * This test used to hardcode the version ("3.5.2") in both assertions, which
 * meant every dependency bump broke it — the sharp/@huggingface/transformers
 * bump to 4.3.0 turned both tests red even though nothing about optionality had
 * changed. The version is incidental here; what this file exists to protect is
 * that transformers stays OPTIONAL, so an onnxruntime CUDA install failure
 * cannot abort the whole OmniRoute install. So the version is now checked for
 * consistency with the declaration instead of against a literal.
 *
 * Written without a semver dependency on purpose: `semver` is only present
 * transitively, so requiring it here would make this test fail for a reason that
 * has nothing to do with what it guards.
 */
function assertLockedVersionMatchesDeclaredRange(
  declared: string | undefined,
  locked: string | undefined,
  what: string
): void {
  assert.ok(declared, `${what}: ${TRANSFORMERS} must have a declared version range`);
  assert.ok(locked, `${what}: ${TRANSFORMERS} must be resolved in package-lock.json`);

  // Exact pin, e.g. "4.3.0" — the lock has to match it byte for byte.
  if (/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(declared)) {
    assert.equal(locked, declared, `${what}: lock drifted from the exact pin ${declared}`);
    return;
  }
  // Range ("^4.3.0", "~4.3.0", ">=4.3.0"): require the same major, which is the
  // part a careless bump would actually break.
  const declaredMajor = declared.match(/\d+/)?.[0];
  const lockedMajor = locked.match(/\d+/)?.[0];
  assert.equal(lockedMajor, declaredMajor, `${what}: ${locked} does not match range ${declared}`);
}

test("@huggingface/transformers is optional so onnxruntime CUDA install failures cannot abort OmniRoute install", () => {
  const pkg = readJson<{
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  }>("package.json");

  assert.equal(
    pkg.dependencies?.[TRANSFORMERS],
    undefined,
    "transformers must not be a regular dependency because it pulls onnxruntime-node install scripts"
  );
  assert.ok(
    pkg.optionalDependencies?.[TRANSFORMERS],
    "transformers must be declared in optionalDependencies"
  );
});

test("package-lock marks transformers and its onnxruntime runtime as optional", () => {
  const pkg = readJson<{ optionalDependencies?: Record<string, string> }>("package.json");
  const lock = readJson<{
    packages: Record<
      string,
      {
        version?: string;
        optional?: boolean;
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      }
    >;
  }>("package-lock.json");

  assert.equal(
    lock.packages[""]?.dependencies?.[TRANSFORMERS],
    undefined,
    "root lock dependencies must not keep transformers as mandatory"
  );
  assert.equal(
    lock.packages[""]?.optionalDependencies?.[TRANSFORMERS],
    pkg.optionalDependencies?.[TRANSFORMERS],
    "the lock's root optionalDependencies must mirror package.json verbatim"
  );
  assertLockedVersionMatchesDeclaredRange(
    pkg.optionalDependencies?.[TRANSFORMERS],
    lock.packages["node_modules/@huggingface/transformers"]?.version,
    "package.json vs package-lock.json"
  );

  for (const packagePath of [
    "node_modules/@huggingface/transformers",
    "node_modules/onnxruntime-node",
    "node_modules/onnxruntime-common",
  ]) {
    assert.equal(lock.packages[packagePath]?.optional, true, `${packagePath} should be optional`);
  }
});
